// Lanzador de Ciudadan Media Player.
// Se compila como .exe de Windows con el favicon embebido (/win32icon), de modo que
// el acceso directo del escritorio muestra ese icono (Explorer no siempre respeta
// el IconLocation de un .lnk) y además arranca Electron con los argumentos correctos.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

internal static class Launcher
{
    [STAThread]
    private static int Main()
    {
        string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string electron = Path.Combine(root, "node_modules", "electron", "dist", "electron.exe");

        if (!File.Exists(electron))
        {
            MessageBoxError("No se encuentra Electron en:\n" + electron);
            return 1;
        }

        // Se lanza con la forma comprobada: `electron.exe <flags> .` con la carpeta
        // de trabajo en la raiz del proyecto. Pasar la ruta absoluta de la app como
        // argumento posicional hace que Chromium la interprete como URL a abrir
        // (y el browser process muere antes de 'ready').
        string logDir = Path.Combine(root, "logs");
        Directory.CreateDirectory(logDir);
        string logFile = Path.Combine(logDir, "electron-launch.out");
        string inner = "\"" + electron + "\" --no-sandbox --user-data-dir=\"" +
                       Path.Combine(root, ".electron-userdata") + "\" . > \"" + logFile + "\" 2>&1";
        // cmd.exe /c quita la primera y la ultima comilla cuando la cadena empieza
        // por comilla: hay que envolver la orden completa entre comillas extra.
        string cmd = inner.StartsWith("\"") ? ("\"" + inner + "\"") : inner;

        try
        {
            File.AppendAllText(Path.Combine(logDir, "launcher.log"),
                DateTime.Now.ToString("s") + " lanzo: " + cmd + Environment.NewLine);
        }
        catch { }

        var psi = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = "/c " + cmd,
            WorkingDirectory = root,
            // UseShellExecute=true desacopla el proceso de la consola/pipe del lanzador:
            // si hereda los descriptores, cualquier terminal que lance el acceso directo
            // se queda esperando a que Electron los cierre.
            UseShellExecute = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };

        try
        {
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBoxError("No se pudo iniciar el reproductor:\n" + ex.Message);
            return 1;
        }
        return 0;
    }

    private static void MessageBoxError(string text)
    {
        try
        {
            System.Windows.Forms.MessageBox.Show(text, "Ciudadan Media Player");
        }
        catch
        {
            Console.Error.WriteLine(text);
        }
    }
}
