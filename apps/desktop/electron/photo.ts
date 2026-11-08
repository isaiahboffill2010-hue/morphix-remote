// Photo / drawing / scan → printable model, from the web portal (or later the touchscreen).
// analyse (free) → confirm cost when Meshy is needed → build → store → AI-advised print prep.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzePhotos, meshyImageCost, photo3dDepsFromEnv, photoToModel, P3D_ERRORS,
  type PhotoAnalysis, type PhotoToModelRequest,
} from "@morphix/photo3d";
import { registerErrorCodes, toMorphixError } from "@morphix/errors";
import { type Ctx, moveProject, now } from "./context";
import type { Actions } from "./actions";
import type { Jobs } from "./jobs";
import type { Printing } from "./printing";

let registered = false;
/** Fold the photo pipeline's MX-P3D codes into the shared error registry once. */
export function registerPhotoErrors(): void {
  if (registered) return;
  registered = true;
  try {
    registerErrorCodes(
      Object.entries(P3D_ERRORS).map(([code, e]) => ({
        code,
        area: "P3D",
        title: e.message.split(/[.:]/)[0],
        hint: e.retryable ? "Try again in a moment." : "Check the photos and description, then try again.",
        description: e.message,
        severity: "error" as const,
        retryable: Boolean(e.retryable),
      })),
      { owner: "photo3d" },
    );
  } catch {
    /* already registered */
  }
}

export interface PhotoJobInput {
  images: { name: string; mime: string; bytes: Buffer }[];
  scan?: { name: string; format: "obj" | "ply" | "stl" | "glb"; path: string };
  description: string;
  measurements: { label: string; value: number; unit: "mm" | "cm" | "in" }[];
  referenceObject: string;
  owner: string;
}

export class PhotoPipeline {
  constructor(private ctx: Ctx, private jobs: Jobs, private actions: Actions, private printing: Printing) {
    registerPhotoErrors();
  }

  /** Starts the job and returns at once; progress follows on the job. */
  start(input: PhotoJobInput): { jobId: string } {
    const title = input.description.trim().slice(0, 60) || "Something from my photos";
    const job = this.jobs.create("photo-to-print", title, input.owner, {}, { print: false });
    // Copy the scan now: the portal deletes its temp upload when the request returns.
    const scan = input.scan ? { name: input.scan.name, bytes: readFileSync(input.scan.path) } : undefined;
    void this.run(job.id, title, input, scan);
    return { jobId: job.id };
  }

  private async run(jobId: string, title: string, input: PhotoJobInput, scan?: { name: string; bytes: Buffer }) {
    const deps = photo3dDepsFromEnv(process.env);
    const base: PhotoToModelRequest = {
      images: input.images.map((i) => ({ mime: i.mime as never, bytes: i.bytes })),
      description: input.description,
      measurements: input.measurements,
      referenceObject: input.referenceObject as PhotoToModelRequest["referenceObject"],
      skipQuestions: true,
      ...(scan ? { scan } : {}),
    };
    try {
      // 1. Look at the photos (free). Scans skip the AI analysis when there are no photos.
      this.jobs.start(jobId, "photos", "Looking at your photos");
      let analysis: PhotoAnalysis | undefined;
      if (input.images.length) {
        if (!deps.gemini) throw new Error("Gemini is not configured (GEMINI_API_KEY)");
        analysis = await analyzePhotos(
          { images: base.images ?? [], description: input.description, measurements: input.measurements, referenceObject: base.referenceObject, hasScanFile: Boolean(scan) },
          { gemini: deps.gemini },
        );
      }
      this.jobs.done(jobId, "photos", analysis ? `${analysis.object.name} — ${analysis.engineReason}` : "Using your 3D scan");
      this.jobs.skip(jobId, "questions", "Using best guesses");

      const engine = scan ? "scan" : (analysis?.recommendedEngine ?? "meshy-image");
      const usesMeshy = engine === "meshy-image" || engine === "meshy-multi-image";
      // Preserve Meshy 7.1's full-detail mesh instead of decimating it to the old
      // 30k-face default. Ultra 4K is single-image only; multi-image supports 2K.
      const meshyQuality = usesMeshy
        ? { geometryResolution: engine === "meshy-multi-image" ? "2k" as const : "4k" as const, shouldRemesh: false }
        : undefined;
      const credits = usesMeshy ? meshyImageCost(meshyQuality) : 0;
      const go = () => void this.build(jobId, title, { ...base, analysis, engine: scan ? "scan" : "auto", meshy: meshyQuality }, deps, credits);

      if (usesMeshy) {
        if (!deps.meshy) throw new Error("Meshy is not configured (MESHY_API_KEY)");
        this.jobs.wait(jobId, "build", `Uses ${credits} Meshy credits — waiting for OK`);
        this.actions.proposeCustom(
          {
            kind: "generate",
            title: analysis?.object.name ?? title,
            prompt: analysis?.meshyPrompt ?? input.description,
            projectId: null,
            versionId: null,
            credits,
            details: [
              `${input.images.length} photo${input.images.length === 1 ? "" : "s"}`,
              analysis ? `about ${fmtDims(analysis)}` : "",
              `Uses ${credits} Meshy credits`,
            ].filter(Boolean),
          },
          () => go(),
          () => this.jobs.cancel(jobId, "cancelled by the user"),
        );
      } else {
        go();
      }
    } catch (e) {
      this.jobs.fail(jobId, "photos", e, "MX-P3D-001");
      this.ctx.log.write("error", "photo job failed", { jobId, error: (e as Error).message });
    }
  }

  private async build(jobId: string, title: string, req: PhotoToModelRequest, deps: ReturnType<typeof photo3dDepsFromEnv>, credits: number) {
    const { db, storage } = this.ctx;
    this.jobs.start(jobId, "build", credits ? `Building (${credits} credits)` : "Building your model");
    try {
      const result = await photoToModel(req, { ...deps, allowFallback: true }, (p) => {
        if (p.stage === "download") {
          this.jobs.done(jobId, "build");
          this.jobs.start(jobId, "download", p.detail);
        } else if (p.stage !== "done" && p.stage !== "failed") {
          this.jobs.update(jobId, "build", p.progress, p.detail);
        }
      });
      if (result.status === "needsAnswers") {
        this.jobs.wait(jobId, "questions", result.questions.join(" "));
        return;
      }
      if (result.status === "failed") {
        throw toMorphixError(Object.assign(new Error(result.error.message), { code: result.error.code }), result.error.code);
      }
      this.jobs.done(jobId, "build");
      this.jobs.done(jobId, "download");

      // Store as a project + version (STL is printable; GLB for a nicer preview when we have one).
      const projectId = randomUUID();
      const versionId = randomUUID();
      const t = now();
      const name = result.analysis?.object.name ?? title;
      db.run("INSERT INTO projects(id, title, prompt, state, created_at, updated_at) VALUES (?,?,?,?,?,?)", [projectId, name.slice(0, 60), req.description, "idea", t, t]);
      moveProject(this.ctx, projectId, "generating");
      const dir = storage.modelDir(projectId, versionId);
      const stlFile = join(dir, "model.stl");
      storage.writeAtomic(stlFile, result.files.stl);
      if (result.files.scad) storage.writeAtomic(join(dir, "model.scad"), result.files.scad);
      let thumbRel: string | null = null;
      if (result.files.thumbnail) {
        const thumb = storage.path("previews", `${versionId}.png`);
        storage.writeAtomic(thumb, result.files.thumbnail);
        thumbRel = storage.relative(thumb);
      }
      const source = result.engine === "openscad" ? "openscad" : result.engine === "scan" ? "scan" : "meshy";
      // STL is in real millimetres here (dimensions were solved), so keep its native size.
      db.run(
        `INSERT INTO model_versions(id, project_id, version, source, kind, format, rel_path, stl_rel_path, bytes, target_height_mm, thumbnail_rel_path, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [versionId, projectId, 1, source, "preview", "stl", storage.relative(stlFile), storage.relative(stlFile), result.files.stl.length, null, thumbRel, t],
      );
      db.run("INSERT INTO assets(id, version_id, kind, rel_path, bytes, sha256, created_at) VALUES (?,?,?,?,?,?,?)", [
        randomUUID(), versionId, "stl", storage.relative(stlFile), result.files.stl.length, createHash("sha256").update(result.files.stl).digest("hex"), t,
      ]);
      db.run("UPDATE projects SET latest_version_id = ?, updated_at = ? WHERE id = ?", [versionId, t, projectId]);
      moveProject(this.ctx, projectId, "reviewing");
      db.flush();
      this.jobs.manager.setMeta(jobId, { projectId, versionId, engine: result.engine, credits: result.costCredits });
      this.ctx.log.write("info", "photo model built", { jobId, projectId, engine: result.engine, size: result.dimensions.actualMm, credits: result.costCredits });

      // Get it ready to print straight away (free), reporting into the same job.
      await this.printing.prepare(versionId, "auto", jobId);
    } catch (e) {
      const running = this.jobs.manager.get(jobId)?.stages.find((s) => s.status === "running")?.key ?? "build";
      this.jobs.fail(jobId, running, e, "MX-P3D-001");
      this.ctx.log.write("error", "photo build failed", { jobId, error: (e as Error).message });
    }
  }
}

function fmtDims(a: PhotoAnalysis): string {
  const d = a.dimensions;
  return `${Math.round(d.width.valueMm)} × ${Math.round(d.depth.valueMm)} × ${Math.round(d.height.valueMm)} mm`;
}
