// Measures how much CPU the sensor layer costs. Run with: node scripts/perf-check.js [srcDir] [seconds]
// Reports whole-machine CPU % (all cores) while polling like the app does, plus a sample of what was read.
const os = require('os');
const path = require('path');
const src = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src'));
const secs = +(process.argv[3] || 30);
const sensors = require(path.join(src, 'sensors.js'));

const cpuTimes = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { idle: 0, total: 0 });

(async () => {
  await sensors.getStatic();
  await sensors.getLive();           // starts background loops
  await sensors.getStorage();
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
  console.log(`RESULT ${path.basename(path.dirname(src))}: machine CPU ${busy.toFixed(1)}% over ${secs}s on ${os.cpus().length} threads (${polls} polls)`);
  console.log('sample:', JSON.stringify({ cpu: last.cpu.load, temp: last.cpu.temp, mem: last.mem.pct, gpus: last.gpus, battery: last.battery.present }).slice(0, 600));
  if (sensors.stopSensors) sensors.stopSensors();
  process.exit(0);
})();
