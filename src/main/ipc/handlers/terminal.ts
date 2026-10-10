/**
 * 系统终端 IPC
 */

import {
  createTerminal,
  killTerminal,
  resizeTerminal,
  writeTerminal,
} from "../../terminal/manager";
import { handle } from "../register";

export function registerTerminalHandlers(): void {
  handle("terminal:create", ({ id, cwd, cols, rows }) =>
    createTerminal(id, cwd, cols, rows),
  );
  handle("terminal:write", ({ id, data }) => writeTerminal(id, data));
  handle("terminal:resize", ({ id, cols, rows }) =>
    resizeTerminal(id, cols, rows),
  );
  handle("terminal:kill", ({ id }) => killTerminal(id));
}
