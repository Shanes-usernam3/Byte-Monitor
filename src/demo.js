// Demo data so the UI can be previewed on a machine/VM with no sensors.
// Launch with:  npm run demo
let t = 0;
const wobble = (base, amp) => Math.round((base + Math.sin(t / 3) * amp + (Math.random() - 0.5) * amp) * 10) / 10;

module.exports = {
  async getStatic() {
    return {
      system: { manufacturer: 'Lenovo', model: 'Legion 5 Pro (Demo)' },
      cpu: { brand: 'AMD Ryzen 7 5800H', cores: 8, threads: 16, speed: 4.4 },
      os: { distro: 'Windows 11 Pro', release: '24H2', arch: 'x64', hostname: 'HP-BENCH-01', platform: 'win32' },
      gpus: [{ model: 'NVIDIA GeForce RTX 3070 Laptop GPU', vendor: 'NVIDIA', vram: 8192 }],
      memModules: [{ size: 17179869184, type: 'DDR4', speed: 3200 }, { size: 17179869184, type: 'DDR4', speed: 3200 }],
    };
  },
  async getLive() {
    t++;
    const coreLoads = Array.from({ length: 16 }, (_, i) => Math.max(1, Math.min(100, Math.round(wobble(28 + (i % 4) * 9, 18)))));
    return {
      ts: Date.now(),
      cpu: {
        load: Math.round(coreLoads.reduce((a, b) => a + b, 0) / 16),
        coreLoads,
        temp: wobble(62, 6),
        tempMax: wobble(71, 5),
        coreTemps: Array.from({ length: 8 }, (_, i) => wobble(58 + i, 5)),
        ghz: wobble(3.6, 0.4),
      },
      mem: { total: 34359738368, used: 14.2e9 + Math.random() * 4e8, pct: wobble(42, 2), swapTotal: 4e9, swapUsed: 3e8 },
      gpus: [{ model: 'NVIDIA GeForce RTX 3070 Laptop GPU', temp: wobble(54, 4), load: Math.round(wobble(18, 10)), memUsed: 1830, memTotal: 8192, fan: 38, power: wobble(32, 6) }],
      battery: {
        present: true, model: 'Celxpert L20C4PC2', unit: 'mWh',
        designCapacity: 80000, fullCapacity: 66420, currentCapacity: 51800,
        healthPct: 83.0, wearPct: 17.0, chargePct: 78, charging: true, acConnected: true,
        cycles: 312, voltage: 15.9, timeRemaining: null, rating: 'Good',
      },
      fans: [{ name: 'CPU Fan', rpm: Math.round(wobble(2650, 150)) }, { name: 'GPU Fan', rpm: Math.round(wobble(2380, 120)) }],
      extraTemps: [{ name: 'Motherboard', value: wobble(44, 1) }, { name: 'VRM', value: wobble(57, 2) }],
      lhm: true,
    };
  },
  async getStorage() {
    return {
      disks: [
        { name: 'Samsung SSD 980 PRO 1TB', device: 'nvme0', type: 'NVMe', interface: 'NVMe', sizeGB: 1000, serial: 'S5GXNX0R', firmware: '5B2QGXA7', smartStatus: 'Ok', temperature: 41, powerOnHours: 6218, powerCycles: 1432, wearUsed: 4, reallocated: null, pending: null, mediaErrors: 0, healthPct: 96, rating: 'Good', notes: [] },
        { name: 'WDC WD20EZAZ-00GGJB0', device: 'sda', type: 'HD', interface: 'SATA', sizeGB: 2000, serial: 'WD-WX92A', firmware: '80.00A80', smartStatus: 'Ok', temperature: 36, powerOnHours: 21907, powerCycles: 980, wearUsed: null, reallocated: 8, pending: 1, mediaErrors: null, healthPct: 79, rating: 'Fair', notes: [] },
      ],
      volumes: [
        { mount: 'C:', fs: 'NTFS', size: 999e9, used: 612e9, pct: 61.3 },
        { mount: 'D:', fs: 'NTFS', size: 2000e9, used: 1508e9, pct: 75.4 },
      ],
    };
  },
};
