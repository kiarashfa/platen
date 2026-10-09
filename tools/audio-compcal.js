// Measures the DynamicsCompressorNode's automatic makeup gain for the settings used in js/audio.js
// (a quiet sine far below threshold should come out at unity once COMP_TRIM is right).
//   node tools/shoot.mjs "/dev/audio.html" --noshot --eval "import('/tools/audio-compcal.js').then(m => m.default())"
export default async function compCal() {
  const sr = 48000, n = sr;
  const run = async withComp => {
    const oc = new OfflineAudioContext(1, n, sr);
    const osc = oc.createOscillator(); osc.frequency.value = 1000;
    const g = oc.createGain(); g.gain.value = Math.pow(10, -30 / 20);
    osc.connect(g);
    if (withComp) {
      const c = oc.createDynamicsCompressor();
      c.threshold.value = -9; c.knee.value = 6; c.ratio.value = 4; c.attack.value = 0.002; c.release.value = 0.12;
      g.connect(c); c.connect(oc.destination);
    } else g.connect(oc.destination);
    osc.start();
    const b = await oc.startRendering();
    const d = b.getChannelData(0);
    let e = 0;
    for (let i = n / 2; i < n; i++) e += d[i] * d[i];
    return Math.sqrt(e / (n / 2));
  };
  const dry = await run(false), wet = await run(true);
  return { makeupDb: +(20 * Math.log10(wet / dry)).toFixed(3) };
}
