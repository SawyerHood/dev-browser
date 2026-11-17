/**
 * Windows: a child inherits every inheritable handle of this process, not only its stdio, and
 * holds it open for as long as it lives. A pipe that reached us that way (PowerShell hands a
 * pipeline's pipe down) never reports EOF to its reader; a socket (Bun leaves them inheritable)
 * never reports its close to the peer. Call right before spawning a child.
 */
export function dropHandleInheritance(): void {
  if (process.platform !== "win32") return;
  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  const { SetHandleInformation } = dlopen("kernel32.dll", {
    SetHandleInformation: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
  }).symbols;
  // Handle values are small multiples of 4; 1 is HANDLE_FLAG_INHERIT.
  for (let handle = 4; handle <= 0x10000; handle += 4) SetHandleInformation(handle, 1, 0);
}
