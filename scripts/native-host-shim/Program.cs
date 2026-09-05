using System;
using System.IO;
using System.Diagnostics;
using System.Text;
using System.Threading;

namespace AntiFan.Bridge
{
    class Program
    {
        static int Main(string[] args)
        {
            try
            {
                string exePath = Process.GetCurrentProcess().MainModule.FileName;
                string exeDir = Path.GetDirectoryName(exePath);

                string targetExe = null;
                string runnerScript = null;

                // Layout 1: Packaged root
                string pRootExe = Path.Combine(exeDir, "antifan-browser-desktop.exe");
                string pRootRunner = Path.Combine(exeDir, "resources", "app.asar.unpacked", ".compiled", "src", "main", "native-messaging", "host-runner.js");
                if (File.Exists(pRootExe) && File.Exists(pRootRunner))
                {
                    targetExe = pRootExe;
                    runnerScript = pRootRunner;
                }

                // Layout 2: Packaged bin directory
                if (targetExe == null)
                {
                    string pBinExe = Path.GetFullPath(Path.Combine(exeDir, "..", "antifan-browser-desktop.exe"));
                    string pBinRunner = Path.GetFullPath(Path.Combine(exeDir, "..", "resources", "app.asar.unpacked", ".compiled", "src", "main", "native-messaging", "host-runner.js"));
                    if (File.Exists(pBinExe) && File.Exists(pBinRunner))
                    {
                        targetExe = pBinExe;
                        runnerScript = pBinRunner;
                    }
                }

                // Layout 3: Development bin directory
                if (targetExe == null)
                {
                    string devBinElectron = Path.GetFullPath(Path.Combine(exeDir, "..", "node_modules", "electron", "dist", "electron.exe"));
                    string devBinRunner = Path.GetFullPath(Path.Combine(exeDir, "..", ".compiled", "src", "main", "native-messaging", "host-runner.js"));
                    if (File.Exists(devBinElectron) && File.Exists(devBinRunner))
                    {
                        targetExe = devBinElectron;
                        runnerScript = devBinRunner;
                    }
                }

                // Layout 4: Development root directory
                if (targetExe == null)
                {
                    string devRootElectron = Path.Combine(exeDir, "node_modules", "electron", "dist", "electron.exe");
                    string devRootRunner = Path.Combine(exeDir, ".compiled", "src", "main", "native-messaging", "host-runner.js");
                    if (File.Exists(devRootElectron) && File.Exists(devRootRunner))
                    {
                        targetExe = devRootElectron;
                        runnerScript = devRootRunner;
                    }
                }

                // Layout 5: Development fallback using node
                if (targetExe == null)
                {
                    string devNodeRunner = Path.GetFullPath(Path.Combine(exeDir, "..", ".compiled", "src", "main", "native-messaging", "host-runner.js"));
                    if (!File.Exists(devNodeRunner))
                    {
                        devNodeRunner = Path.Combine(exeDir, ".compiled", "src", "main", "native-messaging", "host-runner.js");
                    }

                    if (File.Exists(devNodeRunner))
                    {
                        targetExe = "node.exe";
                        runnerScript = devNodeRunner;
                    }
                }

                if (targetExe == null)
                {
                    byte[] errPayload = Encoding.UTF8.GetBytes("{\"status\":\"ERROR\",\"error\":\"HOST_BINARIES_NOT_FOUND\",\"message\":\"AntiFan host binary or runner script could not be located.\"}");
                    byte[] lenBytes = BitConverter.GetBytes(errPayload.Length);
                    using (Stream stdout = Console.OpenStandardOutput())
                    {
                        stdout.Write(lenBytes, 0, 4);
                        stdout.Write(errPayload, 0, errPayload.Length);
                        stdout.Flush();
                    }
                    return 1;
                }

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = targetExe;
                
                StringBuilder argBuilder = new StringBuilder();
                argBuilder.AppendFormat("\"{0}\"", runnerScript);
                for (int i = 0; i < args.Length; i++)
                {
                    argBuilder.AppendFormat(" \"{0}\"", args[i]);
                }
                psi.Arguments = argBuilder.ToString();
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardInput = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = null;
                psi.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";

                Process proc = new Process();
                proc.StartInfo = psi;
                proc.Start();

                // Stream Stdin -> Process.StandardInput
                Thread inputThread = new Thread(() =>
                {
                    try
                    {
                        using (Stream cin = Console.OpenStandardInput())
                        using (Stream pin = proc.StandardInput.BaseStream)
                        {
                            byte[] buffer = new byte[16384];
                            int read;
                            while ((read = cin.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                pin.Write(buffer, 0, read);
                                pin.Flush();
                            }
                        }
                    }
                    catch {}
                    finally
                    {
                        try { proc.StandardInput.Close(); } catch {}
                    }
                });
                inputThread.IsBackground = true;
                inputThread.Start();

                // Stream Process.StandardOutput -> Stdout
                Thread outputThread = new Thread(() =>
                {
                    try
                    {
                        using (Stream cout = Console.OpenStandardOutput())
                        using (Stream pout = proc.StandardOutput.BaseStream)
                        {
                            byte[] buffer = new byte[16384];
                            int read;
                            while ((read = pout.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                cout.Write(buffer, 0, read);
                                cout.Flush();
                            }
                        }
                    }
                    catch {}
                });
                outputThread.IsBackground = true;
                outputThread.Start();

                // Stream Process.StandardError -> Stderr
                Thread errorThread = new Thread(() =>
                {
                    try
                    {
                        using (Stream cerr = Console.OpenStandardError())
                        using (Stream perr = proc.StandardError.BaseStream)
                        {
                            byte[] buffer = new byte[4096];
                            int read;
                            while ((read = perr.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                cerr.Write(buffer, 0, read);
                                cerr.Flush();
                            }
                        }
                    }
                    catch {}
                });
                errorThread.IsBackground = true;
                errorThread.Start();

                proc.WaitForExit();
                outputThread.Join(1000);
                return proc.ExitCode;
            }
            catch (Exception ex)
            {
                byte[] errPayload = Encoding.UTF8.GetBytes(string.Format("{{\"status\":\"ERROR\",\"error\":\"SHIM_EXCEPTION\",\"message\":{0}}}", 
                    EscapeJsonString(ex.Message)));
                byte[] lenBytes = BitConverter.GetBytes(errPayload.Length);
                using (Stream stdout = Console.OpenStandardOutput())
                {
                    stdout.Write(lenBytes, 0, 4);
                    stdout.Write(errPayload, 0, errPayload.Length);
                    stdout.Flush();
                }
                return 1;
            }
        }

        static string EscapeJsonString(string s)
        {
            if (s == null) return "\"\"";
            StringBuilder sb = new StringBuilder();
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '\"': sb.Append("\\\""); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32) sb.AppendFormat("\\u{0:x4}", (int)c);
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }
}
