-- +goose Up
-- +goose StatementBegin

-- ---------------------------------------------------------------------------
-- The login door counted nothing.
--
-- 00002 gave the signup form a floor of rate limiting and said why: "the most
-- exposed surface in the system" needs a limit "that survives a process
-- restart". Signup was never the most exposed surface. Signup costs an attacker
-- a mailbox they control and gives them a farm they already could have had;
-- POST /v1/auth/login is where somebody else's payroll is, and it had no
-- counter of any kind — no lockout, no delay, and no row anywhere afterwards
-- saying it had been tried. A password spray against every address the platform
-- has could run all night and leave the database looking exactly as it did the
-- night before.
--
-- So this is signup_attempts' sibling, for the door that actually matters, and
-- the argument for putting it in Postgres rather than in a map behind a mutex
-- is the one CountSignupAttempts already makes: an in-memory bucket forgets
-- everything on deploy, and a deploy is a thing an attacker can wait for.
--
-- # Why only failures
--
-- signup_attempts carries `succeeded` and every row it has ever written says
-- true, which is a column nothing reads. This table records the refusals and
-- nothing else, because a refusal is the only event the limiter counts and the
-- only one worth keeping: a successful login already leaves a refresh token row
-- with a device and a timestamp on it, which is a better audit trail than a
-- boolean here would be.
--
-- # Why it does not grow without bound
--
-- The handler does NOT record an attempt it has already refused for being over
-- the limit — see handleLogin, where that is what keeps a locked-out address
-- from being held locked for ever by the very traffic that locked it. The
-- consequence here is that one IP can write at most `LoginFailuresPerIP` rows
-- per window, whatever it does, so the write rate is bounded by the limit
-- itself and not by how hard anybody pushes.
--
-- # No farm_id, and therefore no RLS
--
-- Deliberate, and the same shape as signup_attempts. This is read before there
-- is a session, so before there is a tenant: 00008's policy generator only
-- touches tables that have a farm_id, and a row-level policy keyed on
-- current_farm() would make the count come back zero on every login and turn
-- the limiter into decoration. Nothing here is a farm's data — an address and
-- an IP that failed to log in belong to no farm by construction, since the
-- failing caller has not proved they belong to one.
-- ---------------------------------------------------------------------------

CREATE TABLE login_failures (
  id    uuid PRIMARY KEY,
  ip    inet NOT NULL,
  email text NOT NULL,
  at    timestamptz NOT NULL DEFAULT now()
);

-- Two indexes because there are two axes and they are counted separately: an
-- address under attack from a thousand IPs and a single IP working through a
-- thousand addresses are different attacks, and a limiter that only had one of
-- these would miss one of them. Both are (key, at DESC) so the window scan
-- reads the recent end and stops.
CREATE INDEX ix_login_failures_email ON login_failures (lower(email), at DESC);
CREATE INDEX ix_login_failures_ip ON login_failures (ip, at DESC);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS login_failures;
-- +goose StatementEnd
