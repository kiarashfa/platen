// Live-path smoke test for js/audio.js, run inside dev/audio.html:
//   node tools/shoot.mjs "/dev/audio.html" --noshot --eval "import('/tools/audio-livetest.js').then(m => m.default())"
// Calls every public method on the live context, switches profile and ambiences, records and
// replays a few events, and drives the typing pad. Returns what each call returned.
export default async function liveTest() {
  const a = window.audio;
  await a.ready;
  await a.unlock();
  const wait = ms => new Promise(res => setTimeout(res, ms));
  const r = { state: a.context.state };
  r.key = a.key({ char: 'a', pan: 0.2 });
  r.space = a.space({});
  r.back = a.backspace({});
  r.shift = [a.shift(true, {}), a.shift(false, { at: 0.1 })];
  r.bell = a.bell({});
  r.cr = a.carriageReturn({ cols: 30, lines: 1 });
  r.cr0 = a.carriageReturn({ cols: 0 });
  r.lf = a.lineFeed({ lines: 1.5, up: true });
  r.mv = a.carriageMove({ cols: 12 });
  r.mvHalf = a.carriageMove({ cols: 0.5 });
  r.jam = a.jam({});
  r.knob = a.knob({ clicks: 3 });
  r.paperIn = a.paperIn();
  r.paperOut = a.paperOut();
  r.correction = a.correction({});
  r.noArgs = [a.key(), a.space(), a.carriageReturn(), a.lineFeed(), a.knob(), a.correction()];
  a.setProfile('desk'); a.key({ char: 'b' }); r.profile = a.profile; a.setProfile('portable');
  a.setMaster(0.7); a.setMachine(0.8); a.setAmbienceLevel(0.4);
  a.setBell(false); r.bellOff = a.bell({}); a.setBell(true);
  a.setAmbience('fire'); await wait(2500); r.amb1 = a._amb && a._amb.id;
  a.setAmbience('night'); await wait(2500); r.amb2 = a._amb && a._amb.id;
  a.setAmbience('rain'); a.setAmbience('clock'); await wait(2500); r.amb3 = a._amb && a._amb.id;
  a.setAmbience(null); r.amb4 = a._amb;
  let t = 0;
  a.startRecording(() => t);
  r.recKey = a.key({ char: 'x' });
  t = 0.3; r.recCr = a.carriageReturn({ cols: 20 });
  t = 0.8; a.shift(true, { pan: -0.5 });
  const ev = a.stopRecording();
  r.events = ev;
  const buf = await a.renderOffline(ev, 1.5, { ambience: null });
  let pk = 0;
  for (const v of buf.getChannelData(0)) pk = Math.max(pk, Math.abs(v));
  r.replayPeakDb = +(20 * Math.log10(pk)).toFixed(1);
  const pad = document.getElementById('pad');
  pad.focus();
  for (const k of ['H', 'i', ' ', 'Backspace', 'x', 'Enter']) pad.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, shiftKey: k === 'H' }));
  r.padCol = document.getElementById('col').textContent;
  r.ambienceGen = a.stats.ambienceGen;
  return r;
}
