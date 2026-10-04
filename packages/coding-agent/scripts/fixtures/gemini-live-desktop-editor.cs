using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

public static class OmpGeminiLiveDesktopEditor
{
    [STAThread]
    public static void Run(string title, string outputPath, string readyPath)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
        var utf8 = new UTF8Encoding(false);
        using (var form = new Form())
        using (var font = new Font("Consolas", 14))
        {
            form.Text = title;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.ClientSize = new Size(760, 440);
            form.MinimumSize = new Size(480, 320);
            form.ShowInTaskbar = true;
            var editor = new TextBox
            {
                Name = "GeminiLiveSmokeEditor",
                AccessibleName = "Gemini Live owned editor",
                Multiline = true,
                AcceptsReturn = true,
                AcceptsTab = false,
                ScrollBars = ScrollBars.Both,
                WordWrap = false,
                Dock = DockStyle.Fill,
                Font = font
            };
            var label = new Label
            {
                Text = "Owned Gemini Live desktop smoke editor",
                Dock = DockStyle.Top,
                Height = 32,
                Padding = new Padding(8, 8, 0, 0)
            };
            editor.TextChanged += delegate
            {
                File.WriteAllText(outputPath, editor.Text, utf8);
            };
            form.Shown += delegate
            {
                form.Activate();
                editor.Focus();
                Console.WriteLine("Owned editor shown in Windows session {0}", Process.GetCurrentProcess().SessionId);
                File.WriteAllText(readyPath, Process.GetCurrentProcess().Id.ToString(), utf8);
                Console.WriteLine("Owned editor readiness written: {0}", readyPath);
            };
            form.Controls.Add(editor);
            form.Controls.Add(label);
            File.WriteAllText(outputPath, "", utf8);
            Application.Run(form);
        }
    }
}
