import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { Machine, rpcContract } from "./contract";
import { isActive } from "./lib/state";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

function canStart(machine: Machine) {
  return (
    machine.available &&
    machine.connected &&
    !machine.issue &&
    !isActive(machine.login)
  );
}

function LoginCard({
  machine,
  refresh,
}: {
  machine: Machine;
  refresh(): Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const login = machine.login;
  useEffect(() => {
    setCode("");
    setError("");
  }, [login?.id]);
  if (!login) return null;
  async function act(action: "submit" | "cancel") {
    if (!login || pending) return;
    setPending(true);
    setError("");
    try {
      if (action === "submit") {
        const input = code.trim();
        setCode("");
        await rpc.call("submit", {
          hostId: machine.hostId,
          id: login.id,
          code: input,
        });
      } else await rpc.call("cancel", { hostId: machine.hostId, id: login.id });
      await refresh();
    } catch {
      setError(
        "The action did not finish. Refresh to check this login before trying again.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      aria-label={`Login on ${machine.name}`}
    >
      <div>
        <h3 className="font-medium">{machine.name}</h3>
      </div>
      <p
        role="status"
        className={
          login.phase === "error" ? "text-sm text-destructive" : "text-sm"
        }
      >
        {login.message}
      </p>
      {login.phase === "awaiting-code" && login.url && (
        <>
          <Button asChild>
            <a
              href={login.url}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              Open Claude login
            </a>
          </Button>
          <p className="text-xs text-muted-foreground">
            Choose your account in the browser. Paste the code from that login
            into this machine's field.
          </p>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void act("submit");
            }}
          >
            <Input
              type="password"
              aria-label={`Login code for ${machine.name}`}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="Paste login code"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
            />
            <Button type="submit" disabled={pending || !code.trim()}>
              Complete login
            </Button>
          </form>
        </>
      )}
      {(login.phase === "starting" || login.phase === "awaiting-code") && (
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => void act("cancel")}
        >
          Cancel login
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

export function AccountsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const initialized = useRef(false);
  const loading = useRef(false);
  const alive = useRef(true);
  const active = machines?.some((machine) => isActive(machine.login)) ?? false;
  const refresh = useCallback(
    async (fresh = false) => {
      if (loading.current) return;
      loading.current = true;
      try {
        const result = await rpc.call("list", { refresh: fresh });
        if (!alive.current) return;
        setMachines(result.machines);
        if (!initialized.current) {
          setSelected(
            new Set(
              result.machines.filter(canStart).map((machine) => machine.hostId),
            ),
          );
          initialized.current = true;
        }
      } catch {
        if (alive.current)
          setError("Could not load machines. Refresh to retry.");
      } finally {
        loading.current = false;
      }
    },
    [rpc],
  );
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(
      () => {
        void refresh();
      },
      active ? 1500 : 15000,
    );
    return () => clearInterval(timer);
  }, [active, refresh]);
  const eligible =
    machines?.filter(
      (machine) => selected.has(machine.hostId) && canStart(machine),
    ) ?? [];
  async function start(hostIds: string[]) {
    if (busy || !hostIds.length) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const results = await rpc.call("start", { hostIds });
      const failures = results.filter((result) => result.error);
      if (failures.length)
        setError(
          failures
            .map(
              (result) =>
                `${machines?.find((machine) => machine.hostId === result.hostId)?.name}: ${result.error}`,
            )
            .join(" "),
        );
      if (results.some((result) => result.login))
        setNotice(
          "Complete each machine's login below. You can return to this page while a login is pending.",
        );
      await refresh();
    } catch {
      setError(
        "Could not start the switch. Refresh to see whether any logins started.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-5 p-4 md:p-6">
        <p className="text-sm text-muted-foreground">
          Choose your machines, then choose your account on Claude’s login page.
          You can do this from any browser, including your phone.
        </p>
        <fieldset className="space-y-2">
          <legend className="mb-2 font-medium">Machines</legend>
          {machines === null ? (
            <p role="status">Checking machines...</p>
          ) : machines.length === 0 ? (
            <p>No machines are registered in BB.</p>
          ) : (
            machines.map((machine) => (
              <div
                key={machine.hostId}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm"
              >
                <label className="flex min-w-0 flex-1 items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(machine.hostId)}
                    disabled={busy || !canStart(machine)}
                    onChange={(event) =>
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (event.target.checked) next.add(machine.hostId);
                        else next.delete(machine.hostId);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{machine.name}</span>
                    <span className="block break-words text-muted-foreground">
                      {machine.issue ??
                        machine.identity?.email ??
                        "Login needed (signed out or expired)"}
                    </span>
                    {machine.identity?.organization && (
                      <span className="block break-words text-xs text-muted-foreground">
                        {machine.identity.organization}
                      </span>
                    )}
                  </span>
                </label>
                {canStart(machine) && (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`${machine.identity ? "Switch account" : "Log in"} on ${machine.name}`}
                    disabled={busy}
                    onClick={() => void start([machine.hostId])}
                  >
                    {machine.identity ? "Switch account" : "Log in"}
                  </Button>
                )}
              </div>
            ))
          )}
        </fieldset>
        <p className="text-sm text-muted-foreground">
          Pause active Claude sessions before switching, then resume them after
          login. Running sessions are not restarted. Work can still spend extra
          usage until you switch away.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || !eligible.length}
            onClick={() => void start(eligible.map((machine) => machine.hostId))}
          >
            {busy
              ? "Starting..."
              : `Switch account on ${eligible.length} ${eligible.length === 1 ? "machine" : "machines"}`}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError("");
              void refresh(true);
            }}
          >
            Refresh
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
        <div className="space-y-3">
          {machines
            ?.filter((machine) => machine.login)
            .map((machine) => (
              <LoginCard
                key={machine.hostId}
                machine={machine}
                refresh={refresh}
              />
            ))}
        </div>
      </div>
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "accounts",
    title: "Claude Accounts",
    icon: "Repeat",
    path: "accounts",
    component: AccountsPage,
  });
});
