package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/auth"
	"github.com/ojardila/bascula/services/api/internal/domain"
	"github.com/ojardila/bascula/services/api/internal/store"
	"github.com/ojardila/bascula/services/api/internal/tenant"
)

// The people who can log in to a farm.
//
// Until this file existed, the only way to create a user was to register a new
// farm: the invite screen was built, it named the routes it expected, and the
// routes were not there. Four operations — list, invite, change a role, take
// the access away — and two rules that the interface cannot be trusted to keep
// because a client can always send the request the screen does not offer.
//
// # The two rules
//
//  1. A FARM ALWAYS KEEPS AT LEAST ONE OWNER. Demoting or removing the last
//     one is refused. A farm with no owner is not recoverable from inside the
//     product: nobody left can write the farm record, set a price or promote
//     anybody, and the only fix is somebody with database access.
//
//  2. NOBODY RAISES THEIR OWN ROLE. And, because the first half is worth
//     nothing on its own, nobody GRANTS a role above their own either: an
//     administrator who could make a second account an owner could log into it
//     and make the first one an owner too. The self-check without the grant
//     check is a lock on a door with no wall beside it.
//
//     The same wall has to stand on the other side of the door, and for a long
//     time it did not: NOBODY CHANGES THE ROLE OR REMOVES THE ACCESS OF
//     SOMEBODY SENIOR TO THEM. An administrator who cannot make an owner but
//     can unmake one has the farm anyway — he demotes both owners to weigher,
//     which grants nothing above his own role and so walked straight past the
//     grant check, or deletes their memberships, which grants nothing at all.
//     Their sessions die with the membership and the senior role is left with
//     nobody in it. Seniority a junior can take away is not seniority.
//
// All of these are checked here rather than in the database, deliberately:
// their error messages are part of what the screen has to say, and "the last
// owner cannot be removed" is a sentence, not a constraint name.

// roleRank orders the three farm roles. It is the only place seniority is
// written down as a number, and it exists for rule 2: "above your own" needs an
// order, and comparing enum strings would sort admin above owner.
func roleRank(r domain.Role) int {
	switch r {
	case domain.RoleOwner:
		return 3
	case domain.RoleAdmin:
		return 2
	case domain.RoleWeigher:
		return 1
	}
	return 0
}

func parseRole(raw string) (domain.Role, error) {
	switch domain.Role(raw) {
	case domain.RoleOwner:
		return domain.RoleOwner, nil
	case domain.RoleAdmin:
		return domain.RoleAdmin, nil
	case domain.RoleWeigher:
		return domain.RoleWeigher, nil
	}
	return "", domain.BadRequest(`role must be "owner", "admin" or "weigher"`)
}

// mayGrant is rule 2's grant half. An empty caller role — which cannot happen
// behind the permission table, but is not worth trusting — grants nothing.
func mayGrant(caller *auth.Principal, role domain.Role) error {
	if caller == nil || roleRank(role) > roleRank(caller.Role) {
		return domain.Forbidden(
			"you cannot give somebody a role above your own; an owner does that")
	}
	return nil
}

// mayActOn is rule 2's downward half: it looks at the person, where mayGrant
// looks only at the role being handed out. Both doors need it, and for the
// same reason — PATCH {"role":"weigher"} aimed at an owner grants nothing
// above the caller's own role, and DELETE grants nothing at all, so the grant
// check has no opinion about either and used to wave both through.
//
// EQUAL RANKS ARE ALLOWED, and that is a decision rather than an oversight.
// The two self-checks in this file answer the person they refuse with "another
// administrator does that": a peer is the remedy the product offers, and a
// rule that forbade peers would make that sentence a lie. It would also leave
// rule 1 with no way out — nothing outranks an owner, so an owner could then
// be demoted or removed by nobody at all, and "name another owner first" would
// name a second person neither of whom can ever be taken back off.
//
// The platform flag grants no exemption here in either direction. The console
// is a different room: auth.Matrix gives the super-admin the farm list and
// nothing else, and inside a farm they hold a membership like everybody else
// and act with the role it carries.
func mayActOn(caller *auth.Principal, target domain.Role) error {
	if caller == nil || roleRank(target) > roleRank(caller.Role) {
		return domain.Forbidden(
			"you cannot change the access of somebody whose role is above your own; " +
				"an owner does that")
	}
	return nil
}

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	users, err := store.ListFarmUsers(r.Context(), tx)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": users})
}

type inviteUserRequest struct {
	Email string `json:"email"`
	Name  string `json:"name"`
	Role  string `json:"role"`
	// Password is optional. When it is absent the server mints one and returns
	// it ONCE, in this response and nowhere else — see the note in the handler.
	// Either way it is a password for THIS farm only.
	Password string `json:"password"`
}

// createInvitedUser creates the account an invite names when the address is
// new to the platform: with a password nobody knows (unusableHash) and the
// address NOT verified. The administrator's password goes on the farm, not
// here; see handleInviteUser.
func createInvitedUser(ctx context.Context, tx pgx.Tx, email, name, unusableHash string) (*store.User, error) {
	user := &store.User{ID: newID(), Email: email, Name: name, PasswordHash: unusableHash}
	if err := store.CreateUser(ctx, tx, *user); err != nil {
		if store.IsUniqueViolation(err, "ux_users_email") {
			// Two invites for the same new address raced. Both
			// administrators meant the same thing; the loser tries again.
			return nil, domain.Coded(http.StatusConflict, domain.CodeEmailTaken,
				"that address was just registered; invite it again to add it here")
		}
		return nil, err
	}
	return user, nil
}

// newUnusablePasswordHash is a real argon2id hash of 32 random bytes nobody
// keeps. It is what an invited account's global password is until somebody
// proves the mailbox: a real hash, so the login check runs exactly as for any
// other account, of a secret that exists nowhere.
func newUnusablePasswordHash() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return auth.HashPassword(base64.RawURLEncoding.EncodeToString(raw))
}

// handleInviteUser adds somebody to the farm.
//
// # Why this is not an emailed invitation
//
// A mailer is optional (Config.Mailer), and weighers often have no mailbox
// they can use, so the farm works the way it always has: the person who buys
// the weighing app sets up the weigher's phone, standing next to them, and
// hands the password over in person. Where there is a mailer, the invitee also
// gets a notice that carries no secret (noticeFarmAccessGranted), and the
// farm's other owners hear about a new owner or administrator
// (noticeRoleRaised).
//
// # The password is the farm's, never the account's
//
// An administrator vouches for nothing about an address. Until this change an
// invite to a new address created a global account, verified, with the
// administrator's password — so a farm administrator owned a verified account
// for somebody else's email, and every farm that later invited the same
// address joined that account. Now:
//
//   - A new address gets an account with a password nobody knows and an
//     unverified address. The password typed or minted here is stored as this
//     farm's credential (store.SetFarmCredential, the table farm-scoped owner
//     passwords already used), and login lets an unverified account open
//     exactly the farms whose own password it typed (onlyFarmScoped). It does
//     not open the main domain's account, any other farm, or the address.
//   - The address's real owner takes the account by proving the mailbox: a
//     signup replaces an unverified claim (store.ReplaceUnverifiedClaim) and
//     the mailed link verifies it; or a password reset, which verifies the
//     address, sets the global password and drops every farm credential —
//     after which this farm opens with that global password, because the
//     address it was given to has now been proved. The weigher who held the
//     handed-over password loses this farm in that case, which is right: the
//     administrator gave the farm to that ADDRESS, and the address turned out
//     to be somebody's. The administrator removes and re-invites with the
//     right address.
//
// # One answer, whoever the address belongs to
//
// The administrator learns nothing about the address. "New to the platform"
// and "has an account elsewhere" do the same work (two argon2id hashes, one
// membership, one farm credential) and answer the same thing: 201, the
// membership as this farm sees it (store.FarmUser: the name typed here, no
// verified date), and the password when the server minted it. An existing
// account therefore also gets a farm password for this farm, and its own
// global password does not open this farm until a reset — the price of not
// telling the administrator that the account existed. Its password, other
// farms and passkeys are untouched, and a session opened with the farm's
// password reaches only farm-pinned passkeys (passkeysThisSessionReaches).
//
// An address that is ALREADY A MEMBER here answers 201 with the membership it
// has and changes nothing — not the role (a retry that silently re-roled
// somebody would be a demotion nobody asked for; that is PATCH) and not the
// password (an administrator re-inviting an owner must not get a password
// that signs in as that owner). It carries no temporaryPassword; that says
// nothing the member list does not already say.
func (s *Server) handleInviteUser(w http.ResponseWriter, r *http.Request) {
	var body inviteUserRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	caller, _ := auth.PrincipalFrom(r.Context())
	email, role, err := validInviteRequest(&body, caller)
	if err != nil {
		writeError(w, r, err)
		return
	}
	name := strings.TrimSpace(body.Name)

	// Both hashes before anything is looked up, whoever the address is, so
	// the time the answer takes does not say it either.
	secrets, err := newInviteSecrets(body.Password)
	if err != nil {
		writeError(w, r, err)
		return
	}

	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	farmID, err := tenant.FarmID(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}

	user, already, err := findOrCreateInvitee(r.Context(), tx, email, name, secrets.unusable)
	if err != nil {
		writeError(w, r, err)
		return
	}

	if !already {
		if err := grantInvitedMembership(r.Context(), tx, farmID, user.ID, role, name, secrets.farmHash); err != nil {
			writeError(w, r, err)
			return
		}
	}
	member, err := store.GetFarmUser(r.Context(), tx, user.ID)
	if err != nil {
		writeError(w, r, err)
		return
	}

	out := map[string]any{
		"id": member.ID, "email": member.Email, "name": member.Name,
		"role": member.Role, "emailVerifiedAt": member.EmailVerifiedAt,
		"createdAt": member.CreatedAt,
	}
	if !already {
		s.noticeRoleRaised(r, tx, member.Email, member.Name, member.Role)
		s.noticeFarmAccessGranted(r, tx, member.Email, member.Name, member.Role)
		if secrets.minted {
			// Returned once, here, and stored nowhere in readable form — the
			// row keeps an argon2id hash like every other password. The
			// administrator has to hand it over now; there is no second
			// chance to read it and the message says so.
			out["temporaryPassword"] = secrets.password
			out["temporaryPasswordNote"] = "shown once: hand it over now, it cannot be read again"
		}
	}
	writeJSON(w, http.StatusCreated, out)
}

// validInviteRequest checks an invitation and returns the normalized address
// and the role it grants, which the caller must be allowed to grant.
func validInviteRequest(body *inviteUserRequest, caller *auth.Principal) (string, domain.Role, error) {
	email := strings.TrimSpace(strings.ToLower(body.Email))
	if email == "" || !strings.Contains(email, "@") {
		return "", "", domain.BadRequest("email is required")
	}
	role, err := parseRole(body.Role)
	if err != nil {
		return "", "", err
	}
	if err := mayGrant(caller, role); err != nil {
		return "", "", err
	}
	if body.Password != "" && len(body.Password) < 10 {
		return "", "", domain.BadRequest("password must be at least 10 characters")
	}
	// The ceiling is here too even though this route is behind a token: an
	// administrator is trusted to add somebody to their own farm, not to decide
	// how much memory the server spends on a single request. See
	// auth.MaxPasswordLength.
	if len(body.Password) > auth.MaxPasswordLength {
		return "", "", domain.BadRequest("password is too long")
	}
	return email, role, nil
}

// inviteSecrets are the passwords an invitation needs: the farm password
// (the one given, or a minted one) and its hash, and an unusable global hash
// for an account created by the invitation.
type inviteSecrets struct {
	password string
	minted   bool
	farmHash string
	unusable string
}

// newInviteSecrets mints (when none was given) and hashes the invitation's
// passwords.
func newInviteSecrets(given string) (*inviteSecrets, error) {
	password, minted := given, given == ""
	if minted {
		var err error
		if password, err = newTemporaryPassword(); err != nil {
			return nil, domain.Internal("could not mint a password").WithCause(err)
		}
	}
	farmHash, err := auth.HashPassword(password)
	if err != nil {
		return nil, domain.Internal("could not hash the password").WithCause(err)
	}
	unusable, err := newUnusablePasswordHash()
	if err != nil {
		return nil, domain.Internal("could not hash the password").WithCause(err)
	}
	return &inviteSecrets{password: password, minted: minted, farmHash: farmHash, unusable: unusable}, nil
}

// findOrCreateInvitee returns the account behind the invited address,
// creating it when there is none, and whether it is already a member here.
func findOrCreateInvitee(ctx context.Context, tx pgx.Tx, email, name, unusable string) (*store.User, bool, error) {
	user, err := store.FindUserByEmail(ctx, tx, email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, false, err
	}
	if user == nil {
		user, err = createInvitedUser(ctx, tx, email, name, unusable)
		return user, false, err
	}
	if _, err := store.GetFarmUser(ctx, tx, user.ID); err == nil {
		return user, true, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, false, err
	}
	return user, false, nil
}

// grantInvitedMembership makes the invitee a member of this farm, with the
// farm password the invitation carries.
func grantInvitedMembership(ctx context.Context, tx pgx.Tx, farmID, userID string, role domain.Role,
	name, farmHash string) error {
	if err := store.CreateMembership(ctx, tx, farmID, userID, role); err != nil {
		return err
	}
	return store.SetFarmCredential(ctx, tx, farmID, userID, name, farmHash)
}

// handleUpdateUserRole is rule 2 in one place.
func (s *Server) handleUpdateUserRole(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Role string `json:"role"`
	}
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	role, err := parseRole(body.Role)
	if err != nil {
		writeError(w, r, err)
		return
	}
	id := chi.URLParam(r, "id")
	caller, _ := auth.PrincipalFrom(r.Context())
	if err := mayGrant(caller, role); err != nil {
		writeError(w, r, err)
		return
	}

	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	// A member of another farm is a 404, not a role change. `users` has no
	// farm_id and therefore no RLS policy, so this lookup — which goes through
	// memberships — is the boundary.
	target, err := store.GetFarmUser(r.Context(), tx, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	// Rule 2 downwards, and it comes before the no-op shortcut below rather
	// than after it: an administrator has no business addressing an owner's
	// membership at all, and answering 200 with the owner's row for the PATCH
	// that happens to change nothing would make the refusal depend on what the
	// caller guessed the role already was.
	if err := mayActOn(caller, target.Role); err != nil {
		writeError(w, r, err)
		return
	}
	if target.Role == role {
		writeJSON(w, http.StatusOK, target)
		return
	}

	if caller != nil && caller.UserID == target.ID && roleRank(role) > roleRank(target.Role) {
		writeError(w, r, domain.Forbidden(
			"you cannot raise your own role; another administrator does that"))
		return
	}

	// Rule 1. Only a change that takes the owner role AWAY can break it.
	if target.Role == domain.RoleOwner {
		owners, err := store.CountFarmOwners(r.Context(), tx)
		if err != nil {
			writeError(w, r, err)
			return
		}
		if owners <= 1 {
			writeError(w, r, domain.Conflict(domain.CodeLastOwner,
				"this farm would be left with no owner; name another owner first"))
			return
		}
	}

	if err := store.SetMembershipRole(r.Context(), tx, id, role); err != nil {
		writeError(w, r, err)
		return
	}
	updated, err := store.GetFarmUser(r.Context(), tx, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if roleRank(role) > roleRank(target.Role) {
		s.noticeRoleRaised(r, tx, updated.Email, updated.Name, role)
	}
	writeJSON(w, http.StatusOK, updated)
}

// handleRemoveUser takes an account's access to this farm away.
//
// It removes the membership and revokes the account's refresh tokens for this
// farm in the same transaction. Leaving the tokens alive would mean "access
// removed" and "still logged in for the next sixty days" at once, and the
// person being removed is often exactly the person whose handset is the reason
// for removing them.
func (s *Server) handleRemoveUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	caller, _ := auth.PrincipalFrom(r.Context())

	tx, err := tenant.Tx(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	farmID, err := tenant.FarmID(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	target, err := store.GetFarmUser(r.Context(), tx, id)
	if err != nil {
		writeError(w, r, err)
		return
	}

	// Rule 2 downwards, before anything is read or written. This is the door
	// where the old gap cost most: the membership goes and the refresh tokens
	// go with it in the same transaction, so an administrator deleting an
	// owner was not asking for a role change he might argue about later — he
	// was ending that owner's sessions on the spot.
	//
	// It stands ahead of the owner count on purpose. To an administrator, "this
	// farm would be left with no owner; name another owner first" is not the
	// truth: naming another owner would not let him remove this one either.
	if err := mayActOn(caller, target.Role); err != nil {
		writeError(w, r, err)
		return
	}

	// Removing your own access logs you out of the farm you are administering,
	// with no way back in from inside the product. It is refused rather than
	// confirmed by a dialog, because the request can arrive without one.
	if caller != nil && caller.UserID == target.ID {
		writeError(w, r, domain.Conflict(domain.CodeConflict,
			"you cannot remove your own access; another administrator does that"))
		return
	}

	// The platform administrator's membership is not this farm's to delete.
	//
	// tenant.setContext already exempts them from the revocation cut for a
	// reason it states there: "their token is pinned to a farm like everybody
	// else's, and an owner of that farm removing them would lock the lever
	// holder out of the room the lever is in." That exemption saves the access
	// token in their hand and nothing more. Login is where it runs out —
	// an account with no memberships is answered "that account belongs to no
	// farm", and the session it would have issued is what the console is
	// reached with. So the farm that holds the only membership of the platform
	// administrator can end the platform administrator, permanently, and the
	// only fix is somebody with database access. Rule 1 above calls exactly
	// that outcome unacceptable one farm down.
	//
	// It is refused in plain words rather than by a mute 403, because the
	// person reading it is an owner who will otherwise think the console is
	// broken, and because the fact disclosed — that this account is ours — is
	// one they can already infer from an account they did not create sitting
	// in their own member list.
	//
	// PATCH needs no such rule: the console's actions are open to every farm
	// role once the platform flag is present (see auth.Matrix), so a demotion
	// costs the platform administrator nothing but a fresh token.
	if target.IsSuperadmin {
		writeError(w, r, domain.Conflict(domain.CodeConflict,
			"that account belongs to the platform and cannot be removed here; "+
				"ask support to detach it"))
		return
	}

	// Rule 1. The rank check above already makes this door hard to reach: only
	// an owner may remove an owner, and if there is just one owner left she IS
	// the target, which the self-check refuses first. It stays because rule 1
	// is not a consequence of rule 2 and must not start depending on it — the
	// day a fourth role or a support impersonation lands, this is the line
	// that still says a farm keeps an owner.
	if target.Role == domain.RoleOwner {
		owners, err := store.CountFarmOwners(r.Context(), tx)
		if err != nil {
			writeError(w, r, err)
			return
		}
		if owners <= 1 {
			writeError(w, r, domain.Conflict(domain.CodeLastOwner,
				"this farm would be left with no owner; name another owner first"))
			return
		}
	}

	if err := store.RevokeUserSessions(r.Context(), tx, farmID, target.ID); err != nil {
		writeError(w, r, err)
		return
	}
	if err := store.DeleteMembership(r.Context(), tx, id); err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

// newTemporaryPassword mints something a person can read off a screen and type
// into a phone once. base64url of 12 random bytes: 96 bits, no ambiguity about
// case, and nothing to mistype except the alphabet itself.
func newTemporaryPassword() (string, error) {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
