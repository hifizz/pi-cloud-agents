import { useEffect, useReducer, useState } from "react";
import { emptyVM, reduce, type Frame } from "../lib/reducer";
import { BotStream } from "../lib/stream";
import type { ConversationVM, StreamStatus } from "../types";

type Action = { type: "frame"; frame: Frame } | { type: "reset" };

function vmReducer(vm: ConversationVM, action: Action): ConversationVM {
  return action.type === "reset" ? emptyVM() : reduce(vm, action.frame);
}

/** Subscribe to one Bot's event stream and expose it as a ConversationVM. */
export function useBotStream(botId: string | undefined): { vm: ConversationVM; status: StreamStatus } {
  const [vm, dispatch] = useReducer(vmReducer, undefined, emptyVM);
  const [status, setStatus] = useState<StreamStatus>("closed");

  useEffect(() => {
    dispatch({ type: "reset" });
    if (!botId) {
      setStatus("closed");
      return;
    }
    const stream = new BotStream({
      botId,
      onFrame: (frame) => dispatch({ type: "frame", frame }),
      onStatus: setStatus,
    });
    stream.start();
    return () => stream.stop();
  }, [botId]);

  return { vm, status };
}
