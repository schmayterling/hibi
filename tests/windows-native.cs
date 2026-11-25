using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Windows calls that tests/windows-native.mjs loads into PowerShell.
public static class HibiTestWindows
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);

    const uint CREATE_NEW_CONSOLE = 0x10, EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    const int STARTF_USESHOWWINDOW = 0x1, STARTF_USESTDHANDLES = 0x100;
    const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002;

    // Runs commandLine in dir, in a hidden console of its own, with stdout and
    // stderr in outPath. Prints its process id as soon as it starts and returns
    // its exit code. Only outPath's handle is inherited, so the caller's pipes
    // close when this returns, whatever the process left running.
    public static uint Run(string commandLine, string outPath, string dir)
    {
        using (var file = new FileStream(outPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
        {
            IntPtr handle = file.SafeFileHandle.DangerousGetHandle();
            SetHandleInformation(handle, 1, 1);
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            IntPtr list = Marshal.AllocHGlobal(size);
            IntPtr handles = Marshal.AllocHGlobal(IntPtr.Size);
            try
            {
                if (!InitializeProcThreadAttributeList(list, 1, 0, ref size))
                    throw new InvalidOperationException("InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());
                Marshal.WriteIntPtr(handles, handle);
                if (!UpdateProcThreadAttribute(list, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                    throw new InvalidOperationException("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());
                var si = new STARTUPINFOEX();
                si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                si.StartupInfo.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
                si.StartupInfo.hStdOutput = handle;
                si.StartupInfo.hStdError = handle;
                si.lpAttributeList = list;
                PROCESS_INFORMATION pi;
                // Ignoring Ctrl+C passes from parent to child, and under Git Bash this
                // process ignores it. A terminal starts its programs with Ctrl+C on.
                SetConsoleCtrlHandler(IntPtr.Zero, false);
                if (!CreateProcess(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, CREATE_NEW_CONSOLE | EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, dir, ref si, out pi))
                    throw new InvalidOperationException("CreateProcess failed: " + Marshal.GetLastWin32Error());
                CloseHandle(pi.hThread);
                Console.Out.WriteLine(pi.dwProcessId);
                Console.Out.Flush();
                WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
                uint code;
                GetExitCodeProcess(pi.hProcess, out code);
                CloseHandle(pi.hProcess);
                return code;
            }
            finally
            {
                DeleteProcThreadAttributeList(list);
                Marshal.FreeHGlobal(list);
                Marshal.FreeHGlobal(handles);
            }
        }
    }

    // Sends Ctrl+C to every process on pid's console, as a terminal does. This
    // process ignores it, and no other console gets it.
    public static void CtrlC(uint pid)
    {
        FreeConsole();
        if (!AttachConsole(pid))
            throw new InvalidOperationException("AttachConsole failed: " + Marshal.GetLastWin32Error());
        SetConsoleCtrlHandler(IntPtr.Zero, true);
        if (!GenerateConsoleCtrlEvent(0, 0))
            throw new InvalidOperationException("GenerateConsoleCtrlEvent failed: " + Marshal.GetLastWin32Error());
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS
    {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RM_PROCESS_INFO
    {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
        public int ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint session, int flags, StringBuilder key);
    [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint session, uint nFiles, string[] files, uint nApps, RM_UNIQUE_PROCESS[] apps, uint nServices, string[] services);
    [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);

    // Every file under folder that a process holds open, as "pid<TAB>path"
    // lines, through the Restart Manager: Windows has no lsof.
    public static string Holders(string folder)
    {
        var lines = new List<string>();
        foreach (string path in Directory.GetFiles(folder, "*", SearchOption.AllDirectories))
        {
            uint session;
            if (RmStartSession(out session, 0, new StringBuilder(33)) != 0) continue;
            try
            {
                if (RmRegisterResources(session, 1, new[] { path }, 0, null, 0, null) != 0) continue;
                uint needed, count = 0, reasons = 0;
                RmGetList(session, out needed, ref count, null, ref reasons);
                if (needed == 0) continue;
                var info = new RM_PROCESS_INFO[needed];
                count = needed;
                if (RmGetList(session, out needed, ref count, info, ref reasons) != 0) continue;
                for (int i = 0; i < count; i++)
                    lines.Add(info[i].Process.dwProcessId + "\t" + path);
            }
            finally
            {
                RmEndSession(session);
            }
        }
        return string.Join("\n", lines);
    }
}
