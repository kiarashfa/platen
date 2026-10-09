"""Platen audio analysis: measures and plots the WAVs exported by dev/audio.html?render=1.

    python tools/audio-analyze.py            # everything found in shots/
    python tools/audio-analyze.py catalog    # only the per-event catalogs

Writes PNGs to shots/ (audio-*.png) and a summary to shots/audio-analysis.json.
numpy + matplotlib only (no scipy).
"""
import json
import sys
import wave
from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SH = ROOT / "shots"
PAPER = "#f3ead6"
INK = "#2a221c"


def readwav(p):
    with wave.open(str(p)) as w:
        sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
        d = np.frombuffer(w.readframes(n), dtype="<i2").astype(np.float64) / 32768.0
    return sr, d.reshape(-1, ch)


def db(x):
    return 20 * np.log10(np.maximum(np.abs(x), 1e-9))


def env_rms(x, sr, ms):
    n = max(1, int(sr * ms / 1000))
    c = np.cumsum(np.concatenate([[0.0], x * x]))
    e = np.sqrt(np.maximum(0, (c[n:] - c[:-n]) / n))
    pad = n // 2
    return np.concatenate([np.full(pad, e[0]), e, np.full(len(x) - len(e) - pad, e[-1])])


def stft(x, sr, win_ms, hop_ms, fmax=None):
    n = max(16, int(sr * win_ms / 1000))
    hop = max(1, int(sr * hop_ms / 1000))
    nfft = 1 << int(np.ceil(np.log2(n * 2)))
    if len(x) < n:
        x = np.pad(x, (0, n - len(x)))
    frames = 1 + (len(x) - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(frames)[:, None]
    w = np.hanning(n)
    S = np.abs(np.fft.rfft(x[idx] * w, nfft, axis=1)) / (np.sum(w) / 2)
    f = np.fft.rfftfreq(nfft, 1 / sr)
    t = (np.arange(frames) * hop + n / 2) / sr
    if fmax:
        k = f <= fmax
        f, S = f[k], S[:, k]
    return t, f, db(S)


def centroid(x, sr):
    if len(x) < 64:
        return 0.0
    X = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    f = np.fft.rfftfreq(len(x), 1 / sr)
    return float(np.sum(f * X) / max(np.sum(X), 1e-20))


def band_share(x, sr, bands):
    X = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    f = np.fft.rfftfreq(len(x), 1 / sr)
    tot = max(np.sum(X), 1e-20)
    return {f"{a}-{b}": round(float(np.sum(X[(f >= a) & (f < b)]) / tot), 3) for a, b in bands}


def sub_events(x, sr, floor_db=-36, min_gap_ms=6, dip_db=4):
    """Distinct impacts: peaks of a 0.5 ms envelope that stand out from what came before."""
    e = db(env_rms(x, sr, 0.5))
    top = e.max()
    gap = int(sr * min_gap_ms / 1000)
    peaks = []
    i = 0
    n = len(e)
    while i < n:
        if e[i] > top + floor_db:
            j = min(n, i + gap)
            k = i + int(np.argmax(e[i:j]))
            if not peaks or (e[k] - e[peaks[-1]:k].min() > dip_db and k - peaks[-1] >= gap):
                peaks.append(k)
            elif peaks and e[k] > e[peaks[-1]] and k - peaks[-1] < gap:
                peaks[-1] = k
            # skip to where the envelope has dropped a few dB below this peak
            m = k
            while m < n and e[m] > e[k] - dip_db:
                m += 1
            i = max(m, i + 1)
        else:
            i += 1
    return [(round(p / sr * 1000, 2), round(float(e[p] - top), 1)) for p in peaks]


def measure(seg, sr):
    mono = seg.mean(axis=1)
    pk_lin = np.abs(seg).max()
    peak = float(db(pk_lin))
    a = np.abs(mono)
    ipk = int(np.argmax(a))
    above10 = np.nonzero(a >= 0.1 * a[ipk])[0]
    on = int(above10[0]) if len(above10) else 0
    # attack of the loudest impact: 0.1 ms envelope, walk back from its peak to 10 % of it
    e01 = env_rms(mono, sr, 0.1)
    ip = int(np.argmax(e01))
    j = ip
    while j > 0 and e01[j] > 0.1 * e01[ip] and ip - j < int(0.01 * sr):
        j -= 1
    k = j
    while k < ip and e01[k] < 0.9 * e01[ip]:
        k += 1
    attack = (k - j) / sr * 1000
    e = db(env_rms(mono, sr, 1.0))
    ie = int(np.argmax(e))
    after = e[ie:]
    d20 = np.nonzero(after < e[ie] - 20)[0]
    d40 = np.nonzero(after < e[ie] - 40)[0]
    active = e > e.max() - 40
    rms = float(db(np.sqrt(np.mean(mono[active] ** 2)))) if active.any() else -120.0
    first = mono[on:on + int(0.08 * sr)]
    return {
        "peak_dbfs": round(peak, 2),
        "rms_active_dbfs": round(rms, 1),
        "attack_ms": round(attack, 3),
        "decay20_ms": round(d20[0] / sr * 1000, 1) if len(d20) else None,
        "decay40_ms": round(d40[0] / sr * 1000, 1) if len(d40) else None,
        "centroid_hz_80ms": round(centroid(first, sr)),
        "bands_80ms": band_share(first, sr, [(0, 400), (400, 1000), (1000, 4000), (4000, 8000), (8000, 24000)]),
        "onset_s": on / sr,
    }


def style(ax):
    ax.set_facecolor("#fbf6ea")
    for s in ax.spines.values():
        s.set_color("#8c6b3c")
    ax.tick_params(colors=INK, labelsize=7)


def plot_event(axw, axs, seg, sr, label, span):
    mono = seg.mean(axis=1)
    t = np.arange(len(mono)) / sr * 1000
    style(axw)
    axw.plot(t, seg[:, 0], lw=0.5, color="#2f4a3a")
    if seg.shape[1] > 1:
        axw.plot(t, seg[:, 1], lw=0.5, color="#6a2328", alpha=0.6)
    axw.set_xlim(0, span * 1000)
    axw.set_title(label, fontsize=9, color=INK, loc="left")
    axw.set_xticklabels([])
    win = 2.0 if span < 0.6 else 6.0
    hop = 0.25 if span < 0.6 else 1.0
    tt, ff, S = stft(mono, sr, win, hop, fmax=16000)
    style(axs)
    axs.pcolormesh(tt * 1000, ff / 1000, S.T, shading="auto", cmap="magma", vmin=S.max() - 80, vmax=S.max())
    axs.set_xlim(0, span * 1000)
    axs.set_ylabel("kHz", fontsize=7)
    axs.set_xlabel("ms", fontsize=7)


def catalog(profile, summary):
    wav = SH / f"audio-catalog-{profile}.wav"
    js = SH / f"audio-catalog-{profile}.json"
    if not wav.exists():
        return
    sr, d = readwav(wav)
    meta = json.loads(js.read_text())
    res = {}
    marks = [m for m in meta["marks"] if m["name"] != "repeat"]
    for m in meta["marks"]:
        if m["name"] != "repeat":
            continue
        # the same key struck 8 times: spread of level and brightness across variants
        rows = []
        specs = []
        for k in range(m["count"]):
            a = int((m["t"] + k * m["every"]) * sr)
            seg = d[a:a + int(m["every"] * sr)]
            mono = seg.mean(axis=1)
            e = env_rms(mono, sr, 0.5)
            ip = int(np.argmax(e))
            s = mono[max(0, ip - int(0.001 * sr)):ip + int(0.006 * sr)]
            specs.append(np.abs(np.fft.rfft(s * np.hanning(len(s)), 4096)) ** 2)
            rows.append((round(float(db(np.abs(seg).max())), 1), round(float(db(e.max())), 1), round(centroid(s, sr))))
        res[m["label"]] = {"peak_db": [r[0] for r in rows], "rms05_db": [r[1] for r in rows], "centroid_strike": [r[2] for r in rows]}
        f = np.fft.rfftfreq(4096, 1 / sr)
        S = np.mean(specs, axis=0)
        summary.setdefault("_strike_ltas", {})[profile] = (f, S)
    per_page = 8
    for page in range(0, len(marks), per_page):
        chunk = marks[page:page + per_page]
        fig = plt.figure(figsize=(14, 2.6 * ((len(chunk) + 1) // 2)), facecolor=PAPER)
        gs = fig.add_gridspec(((len(chunk) + 1) // 2) * 2, 2, height_ratios=[1, 2.2] * ((len(chunk) + 1) // 2), hspace=0.5, wspace=0.12)
        for k, m in enumerate(chunk):
            i0 = int((m["t"] - 0.005) * sr)
            i1 = int(m["end"] * sr)
            seg = d[i0:i1]
            meas = measure(seg, sr)
            mono = seg.mean(axis=1)
            on = int(meas["onset_s"] * sr)
            meas["sub_events_ms_db"] = sub_events(mono[on:on + int(0.3 * sr)], sr)
            res[m["label"]] = meas
            row, col = (k // 2) * 2, k % 2
            span = min(m["end"] - m["t"] + 0.005, 2.2)
            if m["name"] in ("key", "space", "backspace", "jam", "correction", "shift"):
                span = 0.25
            lab = f'{m["label"]}  peak {meas["peak_dbfs"]} dBFS  centroid {meas["centroid_hz_80ms"]} Hz'
            plot_event(fig.add_subplot(gs[row, col]), fig.add_subplot(gs[row + 1, col]), seg, sr, lab, span)
        out = SH / f"audio-cat-{profile}-{page // per_page + 1}.png"
        fig.savefig(out, dpi=80, facecolor=PAPER, bbox_inches="tight")
        plt.close(fig)
    summary[f"catalog_{profile}"] = res


def key_zoom(profile, label, summary):
    wav = SH / f"audio-catalog-{profile}.wav"
    if not wav.exists():
        return
    sr, d = readwav(wav)
    meta = json.loads((SH / f"audio-catalog-{profile}.json").read_text())
    m = next(x for x in meta["marks"] if x["label"] == label)
    seg = d[int(m["t"] * sr):int((m["t"] + 0.2) * sr)]
    mono = seg.mean(axis=1)
    t = np.arange(len(mono)) / sr * 1000
    fig, ax = plt.subplots(4, 1, figsize=(13, 11), facecolor=PAPER, gridspec_kw={"height_ratios": [1, 1, 2, 1.4]})
    for a in ax:
        style(a)
    ax[0].plot(t, mono, lw=0.6, color="#2f4a3a")
    ax[0].set_title(f"{profile}: {label} (waveform, 0-200 ms)", fontsize=10, loc="left")
    ax[0].set_xlim(0, 200)
    ax[1].plot(t, db(env_rms(mono, sr, 0.25)), lw=0.7, color="#6a2328", label="0.25 ms RMS")
    ax[1].plot(t, db(env_rms(mono, sr, 2.0)), lw=1.0, color="#2f4a3a", label="2 ms RMS")
    ax[1].set_ylim(-90, 0)
    ax[1].set_xlim(0, 200)
    ax[1].set_ylabel("dBFS")
    ax[1].legend(fontsize=7)
    tt, ff, S = stft(mono, sr, 1.5, 0.125, fmax=20000)
    ax[2].pcolormesh(tt * 1000, ff / 1000, S.T, shading="auto", cmap="magma", vmin=S.max() - 75, vmax=S.max())
    ax[2].set_xlim(0, 200)
    ax[2].set_ylabel("kHz (1.5 ms window)")
    on = max(0, int(np.argmax(env_rms(mono, sr, 0.5))) - int(0.001 * sr))   # 1 ms before the strike's peak
    for (a, b, c, lab) in [(0, 0.007, "#6a2328", "strike, 7 ms"), (0.007, 0.03, "#2f4a3a", "ring +7..30 ms"), (0.03, 0.08, "#b08d57", "escapement + tail +30..80 ms")]:
        x = mono[on + int(a * sr):on + int(b * sr)]
        X = np.abs(np.fft.rfft(x * np.hanning(len(x)), 8192))
        f = np.fft.rfftfreq(8192, 1 / sr)
        sm = np.convolve(X, np.ones(9) / 9, mode="same")
        ax[3].semilogx(f[1:], db(sm[1:] / max(sm.max(), 1e-12)), color=c, lw=0.9, label=lab)
    ax[3].set_xlim(50, 20000)
    ax[3].set_ylim(-70, 3)
    ax[3].set_xlabel("Hz")
    ax[3].set_ylabel("dB re max")
    ax[3].legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(SH / f"audio-key-{profile}.png", dpi=80, facecolor=PAPER)
    plt.close(fig)


def overview(name, title, summary, span=None):
    p = SH / f"{name}.wav"
    if not p.exists():
        return
    sr, d = readwav(p)
    mono = d.mean(axis=1)
    t = np.arange(len(mono)) / sr
    fig, ax = plt.subplots(3, 1, figsize=(15, 9), facecolor=PAPER, gridspec_kw={"height_ratios": [1, 1, 2.2]})
    for a in ax:
        style(a)
    ax[0].plot(t, d[:, 0], lw=0.3, color="#2f4a3a")
    ax[0].plot(t, d[:, 1], lw=0.3, color="#6a2328", alpha=0.6)
    ax[0].set_ylim(-1, 1)
    ax[0].set_title(title, fontsize=11, loc="left")
    e1 = db(env_rms(mono, sr, 1.0))
    e50 = db(env_rms(mono, sr, 50.0))
    ax[1].plot(t, e1, lw=0.4, color="#6a2328", label="1 ms RMS")
    ax[1].plot(t, e50, lw=1.0, color="#2f4a3a", label="50 ms RMS")
    ax[1].set_ylim(-90, 0)
    ax[1].set_ylabel("dBFS")
    ax[1].legend(fontsize=7, loc="lower right")
    tt, ff, S = stft(mono, sr, 6, 2, fmax=16000)
    ax[2].pcolormesh(tt, ff / 1000, S.T, shading="auto", cmap="magma", vmin=S.max() - 85, vmax=S.max())
    ax[2].set_ylabel("kHz")
    ax[2].set_xlabel("s")
    if span:
        for a in ax:
            a.set_xlim(*span)
    fig.tight_layout()
    fig.savefig(SH / f"{name}.png", dpi=80, facecolor=PAPER)
    plt.close(fig)
    clip = int(np.sum(np.abs(d) >= 0.999))
    summary[name] = {
        "sr": sr, "seconds": round(len(mono) / sr, 2), "peak_dbfs": round(float(db(np.abs(d).max())), 2),
        "rms_dbfs": round(float(db(np.sqrt(np.mean(d ** 2)))), 2), "clipped_samples": clip,
        "p99_1ms_env_dbfs": round(float(np.percentile(e1, 99)), 1),
    }
    return sr, d


def fast_check(summary):
    p = SH / "audio-fast.wav"
    if not p.exists():
        return
    for name in ("audio-fast", "audio-fast-raw", "audio-fast-desk"):
        r = overview(name, f"{name}: 12 keys/s", summary, span=(0, 3.0))
        if not r:
            continue
        sr, d = r
        mono = d.mean(axis=1)
        e = db(env_rms(mono, sr, 1.0))
        # keys are ~83 ms apart: the envelope minimum just before each strike vs that strike's peak
        hop = int(sr / 12)
        dips = []
        for k in range(1, int(len(mono) / hop) - 1):
            w = e[k * hop:(k + 1) * hop]
            dips.append(float(w.max() - w.min()))
        summary[name]["median_peak_to_valley_db"] = round(float(np.median(dips)), 1)


def ambience(summary):
    for amb in ("rain", "fire", "clock", "night"):
        p = SH / f"audio-amb-{amb}.wav"
        if not p.exists():
            continue
        sr, d = readwav(p)
        mono = d.mean(axis=1)
        n = len(mono)
        # seam: loop end -> start should look like any other point
        wrap = np.concatenate([d[-int(0.25 * sr):], d[:int(0.25 * sr)]])
        jump = float(np.abs(d[0] - d[-1]).max())
        typical = float(np.percentile(np.abs(np.diff(d, axis=0)), 99.9))
        e_wrap = db(env_rms(wrap.mean(axis=1), sr, 50))
        e_all = db(env_rms(mono, sr, 50))
        fig, ax = plt.subplots(3, 1, figsize=(14, 9), facecolor=PAPER, gridspec_kw={"height_ratios": [1, 2, 1.4]})
        for a in ax:
            style(a)
        t = np.arange(n) / sr
        ax[0].plot(t, e_all, lw=0.6, color="#2f4a3a")
        ax[0].set_title(f"ambience {amb}: 50 ms RMS over the whole loop ({n / sr:.0f} s)", fontsize=10, loc="left")
        ax[0].set_ylabel("dBFS")
        k = int(12 * sr)
        tt, ff, S = stft(mono[:k], sr, 20, 5, fmax=12000)
        ax[1].pcolormesh(tt, ff / 1000, S.T, shading="auto", cmap="magma", vmin=S.max() - 80, vmax=S.max())
        ax[1].set_ylabel("kHz (first 12 s)")
        X = np.abs(np.fft.rfft(mono[: 1 << 20] if n > (1 << 20) else mono))
        f = np.fft.rfftfreq(min(n, 1 << 20), 1 / sr)
        bins = np.logspace(np.log10(30), np.log10(20000), 120)
        lt = [np.mean(X[(f >= a) & (f < b)] ** 2) if np.any((f >= a) & (f < b)) else 1e-20 for a, b in zip(bins[:-1], bins[1:])]
        ax[2].semilogx(np.sqrt(bins[:-1] * bins[1:]), 10 * np.log10(np.maximum(lt, 1e-20) / max(lt)), color="#6a2328")
        ax[2].set_xlim(30, 20000)
        ax[2].set_ylim(-70, 3)
        ax[2].set_ylabel("LTAS dB")
        ax[2].set_xlabel("Hz")
        fig.tight_layout()
        fig.savefig(SH / f"audio-amb-{amb}.png", dpi=80, facecolor=PAPER)
        plt.close(fig)
        summary[f"amb_{amb}"] = {
            "seconds": round(n / sr, 2), "peak_dbfs": round(float(db(np.abs(d).max())), 2),
            "rms_dbfs": round(float(db(np.sqrt(np.mean(d ** 2)))), 2),
            "seam_jump": round(jump, 5), "p99.9_step": round(typical, 5),
            "seam_rms_db_vs_median": round(float(e_wrap[int(0.2 * sr):int(0.3 * sr)].mean() - np.median(e_all)), 2),
            "lr_correlation": round(float(np.corrcoef(d[:, 0], d[:, 1])[0, 1]), 3),
            "centroid_hz": round(centroid(mono[: 1 << 19], sr)),
        }


def main():
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    summary = {}
    if what in ("all", "catalog"):
        for prof in ("portable", "desk"):
            catalog(prof, summary)
            key_zoom(prof, "key n", summary)
        lt = summary.pop("_strike_ltas", {})
        if lt:
            fig, ax = plt.subplots(figsize=(11, 4.5), facecolor=PAPER)
            style(ax)
            for prof, col in (("portable", "#2f4a3a"), ("desk", "#6a2328")):
                if prof in lt:
                    f, S = lt[prof]
                    sm = np.convolve(S, np.ones(5) / 5, mode="same")
                    ax.semilogx(f[1:], 10 * np.log10(sm[1:] / sm.max()), color=col, lw=1.1, label=f"{prof}: mean of 8 strikes (first 7 ms)")
            ax.set_xlim(50, 20000)
            ax.set_ylim(-60, 3)
            ax.set_xlabel("Hz")
            ax.set_ylabel("dB re max")
            ax.legend(fontsize=8)
            ax.set_title("strike spectrum, 'e' struck 8 times", fontsize=10, loc="left")
            fig.tight_layout()
            fig.savefig(SH / "audio-strike-spectrum.png", dpi=80, facecolor=PAPER)
            plt.close(fig)
    if what in ("all", "demo"):
        overview("audio-demo", "demo performance (portable, rain at 0.45)", summary)
    if what in ("all", "fast"):
        fast_check(summary)
    if what in ("all", "amb"):
        ambience(summary)
    (SH / "audio-analysis.json").write_text(json.dumps(summary, indent=1))
    for k, v in summary.items():
        if k.startswith("catalog_"):
            print(f"\n== {k}")
            print(f'{"event":14} {"peak":>6} {"rmsAct":>6} {"att ms":>6} {"d20":>6} {"d40":>6} {"cent":>5}  lo/400-1k/1-4k/4-8k/8k+   sub-events (ms, dB)')
            for lab, m in v.items():
                if "bands_80ms" not in m:
                    print(f"{lab:14} {json.dumps(m)}")
                    continue
                b = m["bands_80ms"]
                bs = "/".join(f"{int(round(x * 100)):2d}" for x in b.values())
                se = " ".join(f"{t:.0f}:{d:.0f}" for t, d in m["sub_events_ms_db"][:7])
                print(f'{lab:14} {m["peak_dbfs"]:6.1f} {m["rms_active_dbfs"]:6.1f} {m["attack_ms"]:6.2f} {str(m["decay20_ms"]):>6} {str(m["decay40_ms"]):>6} {m["centroid_hz_80ms"]:5d}  {bs:22} {se}')
        else:
            print(f"\n== {k}: {json.dumps(v)}")


if __name__ == "__main__":
    main()
