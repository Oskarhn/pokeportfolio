# P206: delivers a REAL console control event to another process's console (Windows only).
#
#   powershell.exe -NoProfile -File send-console-event.ps1 -TargetPid <pid> -Event CtrlC|CtrlBreak
#
# Node on Windows cannot send SIGINT to a child (child.kill('SIGINT') terminates it without running
# any handler), so a test that wants the real Ctrl+C / Ctrl+Break path has to attach to the target's
# console and generate the event. Ctrl+Break is delivered to every process on that console, this
# sender included, so this process normally dies with STATUS_CONTROL_C_EXIT: callers must not read
# anything into the sender's own exit code. Ctrl+C is ignored by this sender but is also ignored by
# any target whose process tree was started with Ctrl+C disabled (CREATE_NEW_PROCESS_GROUP) - the
# caller detects that by the target not exiting.
param(
  [Parameter(Mandatory = $true)][uint32]$TargetPid,
  [Parameter(Mandatory = $true)][ValidateSet('CtrlC', 'CtrlBreak')][string]$Event
)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleEvents {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint evt, uint group);
}
'@
[void][ConsoleEvents]::FreeConsole()
if (-not [ConsoleEvents]::AttachConsole($TargetPid)) { exit 3 }
[void][ConsoleEvents]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
$evt = if ($Event -eq 'CtrlC') { 0 } else { 1 }
$sent = [ConsoleEvents]::GenerateConsoleCtrlEvent([uint32]$evt, 0)
Start-Sleep -Milliseconds 500
[void][ConsoleEvents]::FreeConsole()
if ($sent) { exit 0 } else { exit 4 }
