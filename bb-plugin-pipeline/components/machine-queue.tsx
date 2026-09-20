import * as Popover from "@radix-ui/react-popover";
import type { MachineQueue } from "@/lib/contract";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { Icon } from "./icon";

function ThreadLink(props: {
  title: string;
  threadId: string | null;
  onOpen(threadId: string): void;
}) {
  const threadId = props.threadId;
  if (threadId === null) {
    return <span className="pipeline-queue-title">{props.title}</span>;
  }
  return (
    <button
      type="button"
      className="pipeline-queue-thread"
      onClick={() => props.onOpen(threadId)}
    >
      {props.title}
    </button>
  );
}

export function MachineQueueStatus(props: {
  queue: MachineQueue;
  onOpen(threadId: string): void;
}) {
  const portalScope = usePortalScopeProps();
  const { queue } = props;
  const emptySlots = Math.max(0, queue.limit - queue.occupied.length);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="pipeline-queue-trigger"
          aria-label={`${queue.hostName} queue, ${queue.occupied.length} of ${queue.limit} slots occupied`}
        >
          <span>{queue.hostName}</span>
          <span className="pipeline-queue-usage">{queue.occupied.length}/{queue.limit}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...portalScope}
          className="pipeline-ui pipeline-popover pipeline-queue-popover"
          align="start"
          sideOffset={6}
          aria-label={`${queue.hostName} queue`}
        >
          <ul className="pipeline-queue-list">
            {queue.occupied.map((task) => (
              <li key={task.cardId} className="pipeline-queue-row">
                <Icon name="Laptop" />
                <ThreadLink title={task.title} threadId={task.threadId} onOpen={props.onOpen} />
              </li>
            ))}
            {emptySlots === 0 ? null : (
              <li className="pipeline-queue-row pipeline-queue-empty">
                <span className="pipeline-queue-slot" aria-hidden="true" />
                <span>{emptySlots} {emptySlots === 1 ? "slot" : "slots"} empty</span>
              </li>
            )}
            {queue.waiting.map((task) => {
              const reason = task.reasons.join(" · ");
              return (
                <li key={task.cardId} className="pipeline-queue-row pipeline-queue-waiting">
                  <Icon name="Clock" />
                  <div className="pipeline-queue-task">
                    <span className="pipeline-queue-task-line">
                      <ThreadLink title={task.title} threadId={task.threadId} onOpen={props.onOpen} />
                      {queue.nextCardId === task.cardId ? <span className="pipeline-next">Next</span> : null}
                    </span>
                    {reason === "" ? null : <span className="pipeline-queue-reason" title={reason}>{reason}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
