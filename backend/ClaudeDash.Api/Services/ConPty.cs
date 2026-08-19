using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace ClaudeDash.Api.Services;

/// <summary>
/// Minimal ConPTY wrapper (Win10 1809+ / Win11). Spawns a child process attached to a
/// pseudo-console — Node.js apps see <c>process.stdout.isTTY === true</c>, which is the
/// whole reason this exists. No NuGet PTY library on .NET 10 currently works reliably.
/// </summary>
public sealed class ConPtyConnection : IDisposable
{
    public Stream Output { get; }
    public Stream Input { get; }
    public Process Process { get; }
    public event EventHandler? Exited;

    private readonly IntPtr _hPC;
    private readonly IntPtr _attrList;
    private bool _disposed;

    public ConPtyConnection(string commandLine, int cols, int rows, string? cwd)
    {
        IntPtr hInputRead = IntPtr.Zero, hInputWrite = IntPtr.Zero;
        IntPtr hOutputRead = IntPtr.Zero, hOutputWrite = IntPtr.Zero;
        var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf<SECURITY_ATTRIBUTES>(), bInheritHandle = true };
        if (!CreatePipe(out hInputRead, out hInputWrite, ref sa, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe(input)");
        if (!CreatePipe(out hOutputRead, out hOutputWrite, ref sa, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe(output)");

        var size = new COORD { X = (short)cols, Y = (short)rows };
        int hr = CreatePseudoConsole(size, hInputRead, hOutputWrite, 0, out _hPC);
        if (hr != 0) throw new Win32Exception(hr, "CreatePseudoConsole");

        CloseHandle(hInputRead);
        CloseHandle(hOutputWrite);

        var inH = new SafeFileHandle(hInputWrite, ownsHandle: true);
        var outH = new SafeFileHandle(hOutputRead, ownsHandle: true);
        Input = new FileStream(inH, FileAccess.Write, bufferSize: 1, isAsync: false);
        Output = new FileStream(outH, FileAccess.Read, bufferSize: 4096, isAsync: false);

        IntPtr lpSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref lpSize);
        _attrList = Marshal.AllocHGlobal(lpSize);
        if (!InitializeProcThreadAttributeList(_attrList, 1, 0, ref lpSize))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList");
        if (!UpdateProcThreadAttribute(_attrList, 0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE_HANDLE,
                _hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute");

        // STARTUPINFOEX marshaled manually to native memory. The crucial bit:
        // STARTF_USESTDHANDLES with NULL hStd* — per GetStdHandle docs, when a process
        // attaches to a new console, NULL std handles get replaced with the console's
        // handles. Without this flag the child inherits the parent's std handles
        // (a pipe in our case) and ConPTY's replacement is skipped.
        int siExSize = Marshal.SizeOf<STARTUPINFOEX>();
        IntPtr siExPtr = Marshal.AllocHGlobal(siExSize);
        try
        {
            for (int i = 0; i < siExSize; i++) Marshal.WriteByte(siExPtr, i, 0);
            Marshal.WriteInt32(siExPtr, 0, siExSize);             // STARTUPINFO.cb
            Marshal.WriteInt32(siExPtr, 60, (int)STARTF_USESTDHANDLES); // STARTUPINFO.dwFlags
            // hStdInput / hStdOutput / hStdError at 80 / 88 / 96 stay zero.
            Marshal.WriteIntPtr(siExPtr, 104, _attrList);         // STARTUPINFOEX.lpAttributeList

            var cmdBuf = new char[commandLine.Length + 1];
            commandLine.CopyTo(0, cmdBuf, 0, commandLine.Length);

            if (!CreateProcessW_Ptr(
                    null, cmdBuf, IntPtr.Zero, IntPtr.Zero, false,
                    EXTENDED_STARTUPINFO_PRESENT,
                    IntPtr.Zero, cwd, siExPtr, out var pi))
                throw new Win32Exception(Marshal.GetLastWin32Error(), $"CreateProcessW '{commandLine}'");

            try
            {
                Process = Process.GetProcessById((int)pi.dwProcessId);
                Process.EnableRaisingEvents = true;
                Process.Exited += (s, e) => Exited?.Invoke(this, EventArgs.Empty);
            }
            finally
            {
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(siExPtr);
        }
    }

    public void Resize(int cols, int rows)
    {
        if (_disposed) return;
        var size = new COORD { X = (short)cols, Y = (short)rows };
        ResizePseudoConsole(_hPC, size);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { ClosePseudoConsole(_hPC); } catch { }
        try { Input.Dispose(); } catch { }
        try { Output.Dispose(); } catch { }
        if (_attrList != IntPtr.Zero)
        {
            try { DeleteProcThreadAttributeList(_attrList); } catch { }
            Marshal.FreeHGlobal(_attrList);
        }
        try { Process?.Dispose(); } catch { }
    }

    // ==== Win32 plumbing ====

    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint DETACHED_PROCESS = 0x00000008;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE_HANDLE = (IntPtr)0x00020016;

    [StructLayout(LayoutKind.Sequential)]
    private struct COORD { public short X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int ResizePseudoConsole(IntPtr hPC, COORD size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int ClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute,
        IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateProcessW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW_Ptr(
        string? lpApplicationName,
        [In, Out] char[] lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        IntPtr lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);
}
