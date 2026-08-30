package httpapi

import (
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
	Password string `json:"password"`
}

// handleInviteUser adds somebody to the farm.
//
// # Why this is not an emailed invitation
//
// There is no mail sender in this service. Signup already works around that by
// echoing the verification token in development, and an "invitation" that mints
// a token nothing can deliver would be a screen that appears to work and never
// does. So the administrator creates the account and hands over the password,
// which is how the farm already works: the person who buys the weighing app is
// the person who sets up the weigher's phone, standing next to them.
//
// The address is marked verified because somebody with a session on this farm
// vouched for it. That is a different act from the open signup, where
// verification is what stops a stranger from registering farms against an
// address they do not own; here the account can only ever reach ONE farm — the
// one whose administrator created it — and that administrator is identified.
//
// # Idempotency
//
// The key is the address, not a client id, because a user is global and a farm
// cannot mint ids in somebody else's namespace. Inviting an address that is
// already a member answers 200 with the membership it already has, and does NOT
// change their role: a repeated invite is a retry, and a retry that silently
// re-roled somebody would be a demotion nobody asked for. Changing a role is
// PATCH, which is a different sentence.
func (s *Server) handleInviteUser(w http.ResponseWriter, r *http.Request) {
	var body inviteUserRequest
	if err := decode(r, &body); err != nil {
		writeError(w, r, err)
		return
	}
	email := strings.TrimSpace(strings.ToLower(body.Email))
	if email == "" || !strings.Contains(email, "@") {
		writeError(w, r, domain.BadRequest("email is required"))
		return
	}
	role, err := parseRole(body.Role)
	if err != nil {
		writeError(w, r, err)
		return
	}
	caller, _ := auth.PrincipalFrom(r.Context())
	if err := mayGrant(caller, role); err != nil {
		writeError(w, r, err)
		return
	}
	if body.Password != "" && len(body.Password) < 10 {
		writeError(w, r, domain.BadRequest("password must be at least 10 characters"))
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

	user, err := store.FindUserByEmail(r.Context(), tx, email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, r, err)
		return
	}

	var temporary string
	if user != nil {
		// The account exists. If it is already here, this is a retry.
		if existing, err := store.GetFarmUser(r.Context(), tx, user.ID); err == nil {
			writeJSON(w, http.StatusOK, existing)
			return
		} else if !errors.Is(err, pgx.ErrNoRows) {
			writeError(w, r, err)
			return
		}
		// It exists elsewhere on the platform. It joins this farm with the
		// role given, and its password is NOT touched: an administrator of one
		// farm resetting the password of an account that belongs to another
		// would be a takeover with an invite button on it.
	} else {
		temporary = body.Password
		if temporary == "" {
			temporary, err = newTemporaryPassword()
			if err != nil {
				writeError(w, r, domain.Internal("could not mint a password").WithCause(err))
				return
			}
		}
		hash, hashErr := auth.HashPassword(temporary)
		if hashErr != nil {
			writeError(w, r, domain.Internal("could not hash the password").WithCause(hashErr))
			return
		}
		user = &store.User{ID: newID(), Email: email, Name: body.Name, PasswordHash: hash}
		if err := store.CreateUser(r.Context(), tx, *user); err != nil {
			if store.IsUniqueViolation(err, "ux_users_email") {
				// Two invites for the same new address raced. The loser reads
				// the winner's row rather than failing: both administrators
				// meant the same thing.
				writeError(w, r, domain.Coded(http.StatusConflict, domain.CodeEmailTaken,
					"that address was just registered; invite it again to add it here"))
				return
			}
			writeError(w, r, err)
			return
		}
		if err := store.VerifyUserEmail(r.Context(), tx, user.ID); err != nil {
			writeError(w, r, err)
			return
		}
	}

	if err := store.CreateMembership(r.Context(), tx, farmID, user.ID, role); err != nil {
		writeError(w, r, err)
		return
	}
	created, err := store.GetFarmUser(r.Context(), tx, user.ID)
	if err != nil {
		writeError(w, r, err)
		return
	}

	out := map[string]any{
		"id": created.ID, "email": created.Email, "name": created.Name,
		"role": created.Role, "emailVerifiedAt": created.EmailVerifiedAt,
		"createdAt": created.CreatedAt,
	}
	if temporary != "" && body.Password == "" {
		// Returned once, here, and stored nowhere in readable form — the row
		// keeps an argon2id hash like every other password. The administrator
		// has to hand it over now; there is no second chance to read it and
		// the message says so.
		out["temporaryPassword"] = temporary
		out["temporaryPasswordNote"] = "shown once: hand it over now, it cannot be read again"
	}
	writeJSON(w, http.StatusCreated, out)
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
