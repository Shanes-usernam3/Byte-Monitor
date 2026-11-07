// Byte Monitor sensor helper
// Prints one JSON snapshot per interval, each followed by a line "@@END@@":
//   { "pawnio": bool, "pawnioVersion": "x.y.z", "hw": [{Name, Identifier, HardwareType}],
//     "lhm": [{Name, SensorType, Value, Parent}] }
// Same shape as LibreHardwareMonitor's WMI classes, so Byte Monitor parses either.
// Exits when stdin closes (i.e. when Byte Monitor quits), so it never lingers.
using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using LibreHardwareMonitor.Hardware;

internal sealed class UpdateVisitor : IVisitor
{
    public void VisitComputer(IComputer computer) => computer.Traverse(this);
    public void VisitHardware(IHardware hardware)
    {
        hardware.Update();
        foreach (IHardware sub in hardware.SubHardware) sub.Accept(this);
    }
    public void VisitSensor(ISensor sensor) { }
    public void VisitParameter(IParameter parameter) { }
}

internal static class Program
{
    private static int Main(string[] args)
    {
        int interval = args.Length > 0 && int.TryParse(args[0], out int ms) ? Math.Clamp(ms, 250, 60000) : 1500;
        bool once = Array.IndexOf(args, "--once") >= 0;

        // parent gone → stdin closes → exit
        if (!once)
        {
            new Thread(() => { try { while (Console.In.ReadLine() != null) { } } catch { } Environment.Exit(0); }) { IsBackground = true }.Start();
        }

        var computer = new Computer
        {
            IsCpuEnabled = true, IsGpuEnabled = true, IsMotherboardEnabled = true, IsControllerEnabled = true,
            IsPsuEnabled = true, IsMemoryEnabled = false, IsStorageEnabled = false, IsBatteryEnabled = false, IsNetworkEnabled = false,
        };
        try { computer.Open(); }
        catch (Exception e) { Console.Error.WriteLine("open failed: " + e.Message); }

        var visitor = new UpdateVisitor();
        var opts = new JsonSerializerOptions { WriteIndented = false };
        Console.Out.Flush();
        while (true)
        {
            var hw = new List<object>();
            var sensors = new List<object>();
            try
            {
                computer.Accept(visitor);
                void Walk(IHardware h)
                {
                    string id = h.Identifier.ToString();
                    hw.Add(new { Name = h.Name, Identifier = id, HardwareType = h.HardwareType.ToString() });
                    foreach (ISensor s in h.Sensors)
                    {
                        float? v = s.Value;
                        if (v.HasValue && (float.IsNaN(v.Value) || float.IsInfinity(v.Value))) v = null;
                        sensors.Add(new { Name = s.Name, SensorType = s.SensorType.ToString(), Value = v, Parent = id });
                    }
                    foreach (IHardware sub in h.SubHardware) Walk(sub);
                }
                foreach (IHardware h in computer.Hardware) Walk(h);
            }
            catch (Exception e) { Console.Error.WriteLine("update failed: " + e.Message); }

            var snapshot = new
            {
                pawnio = LibreHardwareMonitor.PawnIo.PawnIo.IsInstalled,
                pawnioVersion = LibreHardwareMonitor.PawnIo.PawnIo.Version?.ToString(),
                hw,
                lhm = sensors,
            };
            Console.Out.WriteLine(JsonSerializer.Serialize(snapshot, opts));
            Console.Out.WriteLine("@@END@@");
            Console.Out.Flush();
            if (once) break;
            Thread.Sleep(interval);
        }
        try { computer.Close(); } catch { }
        return 0;
    }
}
