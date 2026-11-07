// Measures how much CPU the sensor layer costs. Run with: node scripts/perf-check.js [srcDir] [seconds]
// Reports whole-machine CPU % (all cores) while polling like the app does, plus a sample of what was read.
const os = require('os');
const path = require('path');
const src = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src'));
const secs = +(process.argv[3] || 30);
const sensors = require(path.join(src, 'sensors.js'));

const cpuTimes = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { idle: 0, total: 0 });

(async () => {
  // start-up: the renderer asks for these three in parallel when the window opens
  const t0s = Date.now(), times = {};
  await Promise.all([
    sensors.getStatic().then(() => { times.static = Date.now() - t0s; }),
    sensors.getLive().then(() => { times.firstLive = Date.now() - t0s; }),
    sensors.getStorage().then(() => { times.storage = Date.now() - t0s; }),
  ]);
  const st = `startup ms — system info ${times.static}, first live reading ${times.firstLive}, drives ${times.storage}`;
  console.log(st);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=startup ${path.relative(process.cwd(), src)}::${st}`);
  await new Promise((r) => setTimeout(r, 5000)); // let start-up settle
  const a = cpuTimes();
  const t0 = Date.now();
  let polls = 0, last;
  while (Date.now() - t0 < secs * 1000) {
    last = await sensors.getLive(); polls++;
    if (polls % 30 === 0) await sensors.getStorage();
    await new Promise((r) => setTimeout(r, 1000));
  }
  const b = cpuTimes();
  const busy = 100 * (1 - (b.idle - a.idle) / (b.total - a.total));
  const label = path.relative(process.cwd(), src) || src;
  const msg = `${label}: machine CPU ${busy.toFixed(1)}% over ${secs}s on ${os.cpus().length} threads (${polls} polls)`;
  const sample = JSON.stringify({ cpu: last.cpu.load, temp: last.cpu.temp, mem: last.mem.pct, swap: last.mem.swapUsed, gpus: last.gpus, battery: last.battery.present }).slice(0, 600);
  if (process.env.GITHUB_ACTIONS) { console.log(`::notice title=perf::${msg}`); console.log(`::notice title=sample ${label}::${sample}`); }
  if (sensors._debug) { const d = JSON.stringify(sensors._debug()).slice(0, 900); console.log('debug:', d); if (process.env.GITHUB_ACTIONS) console.log(`::notice title=debug ${label}::${d}`); }
  console.log('RESULT', msg); console.log('sample:', sample);
  if (sensors.stopSensors) sensors.stopSensors();
  process.exit(0);
})();
