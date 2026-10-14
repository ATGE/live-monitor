import { stillStretches } from './qa.js';

/**
 * Condensing a QA video the way a security camera records: keep the frames
 * where something changed, drop the stretches where nothing did, and say how
 * long each stretch was and where.
 *
 * Playwright records the whole browser context and cannot pause, so a step
 * that waits on a progress bar produces minutes of an unchanging frame. Two
 * passes of the ffmpeg Playwright ships fix that after the fact: one finds the
 * still stretches (frames kept by a scene-change select, with their
 * timestamps), the other writes the video without them (`mpdecimate` drops
 * frames nearly identical to the previous, `setpts` closes the gaps). The raw
 * file is deleted once the condensed one exists.
 */

/**
 * A full ffmpeg on the machine's PATH, or null.
 *
 * Playwright ships its own ffmpeg, but that build is cut to the bone —
 * measured here: of the filters this needs it has `scale` and nothing else,
 * no `select`, no `mpdecimate`, no `setpts`, and VP8 is its only encoder. It
 * records; it cannot edit. So condensing needs the real thing (`apt install
 * ffmpeg` on the dev box, winget's Gyan.FFmpeg here), and without it the raw
 * video is kept and the panel says why.
 */
const probes = new Map();   // machine name -> Promise<string|null>
export function ffmpegPath(machine) {
  if (!probes.has(machine.name)) {
    probes.set(machine.name, (async () => {
      for (const candidate of await candidates(machine)) {
        const r = await machine.exec(candidate, ['-hide_banner', '-filters'], { timeoutMs: 30_000 });
        const has = (f) => new RegExp(`\\s${f}\\s`).test(r.stdout);
        if (r.ok && has('mpdecimate') && has('select') && has('setpts') && has('showinfo')) return candidate;
      }
      probes.delete(machine.name);   // not there yet: ask again next time
      return null;
    })());
  }
  return probes.get(machine.name);
}

/**
 * PATH first. On Windows, winget puts portable packages under the user's
 * WinGet folder and only adds it to the PATH of shells opened *afterwards* —
 * a board started from an older shell would not see it, so look there too.
 */
async function candidates(machine) {
  const list = ['ffmpeg'];
  if (machine.kind === 'local' && machine.platform === 'win32' && process.env.LOCALAPPDATA) {
    const packages = machine.path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const pkg of (await machine.fs.readdir(packages)).filter((d) => /ffmpeg/i.test(d))) {
        const root = machine.path.join(packages, pkg);
        for (const inner of await machine.fs.readdir(root)) {
          const bin = machine.path.join(root, inner, 'bin', 'ffmpeg.exe');
          if (await machine.fs.exists(bin)) list.push(bin);
        }
      }
    } catch { /* no winget packages dir */ }
  }
  return list;
}

/**
 * Condenses `input` into `output` on the machine; returns the cuts made.
 * Leaves the raw file alone if ffmpeg is missing or fails — a long video is
 * better than none — and reports why.
 */
export async function condenseVideo(machine, { input, output, minGapSeconds = 8, onLine }) {
  const ffmpeg = await ffmpegPath(machine);
  if (!ffmpeg) return { condensed: false, reason: 'no hay un ffmpeg completo en el PATH (el de Playwright no sabe recortar)', cuts: [] };

  // Pass 1: where did the picture change? showinfo prints one line per kept frame.
  const scan = await machine.exec(ffmpeg, [
    '-hide_banner', '-nostats', '-i', input,
    '-vf', "select='gt(scene,0.002)',showinfo",
    '-an', '-f', 'null', '-',
  ], { timeoutMs: 20 * 60_000 });
  if (!scan.ok) return { condensed: false, reason: `ffmpeg no pudo analizar el vídeo: ${scan.stderr.trim().split('\n').pop()}`, cuts: [] };
  const cuts = stillStretches(scan.stderr, { minGapSeconds });

  // Pass 2: the video without the stillness. Always written, even with no
  // cuts: a re-encode at a fixed rate plays back more reliably than
  // Playwright's variable-rate webm, and the panel then has one format.
  const write = await machine.exec(ffmpeg, [
    '-hide_banner', '-nostats', '-y', '-i', input,
    '-vf', 'mpdecimate=hi=64*12:lo=64*5:frac=0.33,setpts=N/FRAME_RATE/TB',
    // VP8: every ffmpeg with libvpx has it, browsers play it, and QA
    // evidence does not need VP9's extra squeeze.
    '-r', '15', '-an', '-c:v', 'libvpx', '-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '8',
    output,
  ], { timeoutMs: 30 * 60_000, onLine });
  if (!write.ok || !(await machine.fs.exists(output))) {
    return { condensed: false, reason: `ffmpeg no pudo condensar: ${write.stderr.trim().split('\n').pop()}`, cuts };
  }
  await machine.fs.rm(input);
  return { condensed: true, cuts };
}
