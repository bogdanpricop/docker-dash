# Per-container Isolation Posture

**Introduced:** v8.94.0
**Always on. No configuration.**

Docker Dash has detected sandboxed OCI runtimes (Kata Containers, gVisor/runsc,
Firecracker) at the **host** level since v8.8.1, badging them on the System page.
That answers "is a stronger runtime available here?" but not the question that
follows: **which containers aren't using it?**

This feature is the per-container half.

---

## 1. Two surfaces, deliberately different audiences

| Surface | Who sees it | When |
|---------|-------------|------|
| **Container detail → Isolation card** | Everyone | Always |
| **Security Posture finding** | Operators with a sandboxed runtime installed | Only when actionable |

The card is unconditional: it shows which runtime backs the container, whether
that runtime is sandboxed, and — if the container can reach past it — exactly how.
That is useful whether or not you run gVisor.

The posture finding is conditional, on purpose. See §3.

## 2. What counts as "reach"

Ways a container can reach past its runtime toward the host:

| Signal | Severity |
|--------|:--------:|
| Privileged | critical |
| Docker socket mounted | critical |
| `CapAdd=ALL`, `SYS_MODULE` | critical |
| `SYS_ADMIN`, `SYS_RAWIO` | high |
| Host PID namespace | high |
| `seccomp=unconfined`, `apparmor=unconfined` | high |
| `SYS_PTRACE`, `SYS_BOOT`, `NET_ADMIN`, `DAC_READ_SEARCH` | medium |
| Host network / IPC namespace | medium |
| SELinux `label=disable` | medium |

Capability spelling is normalised (`SYS_ADMIN`, `cap_sys_admin`, `CAP_SYS_ADMIN`
are one signal) and de-duplicated. When a container is already privileged its
capabilities are **not** re-listed — privileged implies all of them, and
enumerating them again is noise.

Disabled seccomp/AppArmor/SELinux confinement and Docker-socket mounts are
reported **per container** here for the first time; the CIS benchmark checks
seccomp and AppArmor on the daemon, not per workload.

## 3. Why the posture check is usually silent

A finding is raised only when all three hold:

1. the container has host-level reach, **and**
2. it is not already on a sandboxed runtime, **and**
3. the host has a sandboxed runtime registered.

Condition 3 means most estates see nothing. That is the intended behaviour.
Without it, the remediation would read "go install gVisor and reconfigure your
daemon" — a large ask, and one the CIS benchmark already opens by flagging the
privileged container on its own terms. **Docker Dash does not nag you about
software you have not installed.**

The same condition is evaluated from one cached `docker info` *before* any
container work, so on hosts without a sandboxed runtime the per-container inspect
loop never runs. The product decision and the performance guard are the same line.

Per-host scan cap: 200 running containers. When it truncates, the finding says so
rather than silently under-reporting.

## 4. Relationship to the CIS benchmark

They are complementary, not overlapping:

- **CIS** reports privileged / `CapAdd` / `PidMode=host` as failures in their own
  right — *the door is open*.
- **Isolation posture** treats those same switches as **inputs** and asks a
  different question — *you own a lock and haven't used it*.

One finding per container, never one per switch. Severity is capped at **high**
even for critical reach, because the verdict is "this could be contained better",
not "this is breached" — inflating it would make the posture score double-count
what CIS already counted.

## 5. Remediation is guidance, not a button

The finding suggests recreating the container with `--runtime=<sandboxed>`
(Compose: `runtime:` on the service), and warns that Kata and gVisor do not
support every syscall or device passthrough. There is no one-click fix: moving a
workload onto a sandboxed runtime can break it, and Docker Dash does not make
that call for you. Same principle as the exposed-port check, which refuses to
close ports on your behalf.

If the workload must stay on the shared kernel, the alternative remediation is to
reduce the reach — drop capabilities, remove the privileged flag or the socket
mount.

## 6. API

```
GET /api/containers/:id/isolation
→ { runtime, sandboxed, sandboxAvailable, sandboxOptions, signals, severity, actionable }
```

`requireAuth`, read-only. This endpoint exists so the runtime taxonomy (which
names count as sandboxed) stays in one place — `_categorizeRuntimes` in
`src/services/docker.js` — instead of being duplicated in the frontend.

## 7. Limitations

- **Docker and Podman only.** Kubernetes, Nomad and Incus have their own
  isolation models (RuntimeClass, task drivers); mapping them onto Docker's
  `HostConfig.Runtime` would be a guess.
- **Running containers only.** A stopped container has no reach.
- **User-namespace remapping is shown but not scored.** `userns-remap` is off by
  default nearly everywhere, and a signal that fires on almost every container is
  not a signal.
- **`youki` is classified as sandboxed** by the pre-existing host-level runtime
  patterns, which is arguable — it is a standard OCI runtime written in Rust. Left
  unchanged because that classification also drives the System page badge.
