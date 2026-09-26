package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// OAuthClient is a dynamically registered client (RFC 7591). Most hosts
// (ChatGPT, Claude) register as public clients with no secret and rely on
// PKCE; a host that asks for client_secret_post or client_secret_basic gets a
// secret, kept here only as its SHA-256.
type OAuthClient struct {
	ID           string
	Name         string
	RedirectURIs []string
	// SecretHash is nil for a public client (token_endpoint_auth_method none).
	SecretHash []byte
	AuthMethod string
	Scope      string
	// Metadata is the registration as echoed back to the client, without the
	// secret.
	Metadata []byte
}

func InsertOAuthClient(ctx context.Context, tx pgx.Tx, c OAuthClient) error {
	if c.AuthMethod == "" {
		c.AuthMethod = "none"
	}
	if len(c.Metadata) == 0 {
		c.Metadata = []byte("{}")
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO oauth_clients
		    (id, name, redirect_uris, secret_hash, token_endpoint_auth_method, scope, metadata)
		     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		c.ID, c.Name, c.RedirectURIs, c.SecretHash, c.AuthMethod, c.Scope, c.Metadata)
	return err
}

// CountRecentOAuthClients is how many clients registered within the window,
// platform-wide. It feeds the registration cap every replica shares.
func CountRecentOAuthClients(ctx context.Context, tx pgx.Tx, window time.Duration) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
		SELECT count(*) FROM oauth_clients WHERE created_at > now() - make_interval(secs => $1)`,
		window.Seconds()).Scan(&n)
	return n, err
}

func GetOAuthClient(ctx context.Context, tx pgx.Tx, id string) (*OAuthClient, error) {
	var c OAuthClient
	err := tx.QueryRow(ctx, `
		SELECT id, name, redirect_uris, secret_hash, token_endpoint_auth_method, scope, metadata
		  FROM oauth_clients WHERE id = $1`, id).
		Scan(&c.ID, &c.Name, &c.RedirectURIs, &c.SecretHash, &c.AuthMethod, &c.Scope, &c.Metadata)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// OAuthCode is a one-use authorization code. access_token is the JWT that
// will be handed back at the token endpoint, already signed.
type OAuthCode struct {
	Code                string
	ClientID            string
	RedirectURI         string
	CodeChallenge       string
	CodeChallengeMethod string
	Resource            string
	Scope               string
	AccessToken         string
	ExpiresAt           time.Time
}

func InsertOAuthCode(ctx context.Context, tx pgx.Tx, c OAuthCode) error {
	// Codes are deleted when they are exchanged; one that never is (the
	// connector gave up) would stay for ever. Each new code sweeps the dead.
	if _, err := tx.Exec(ctx, `DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 hour'`); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO oauth_codes
		    (code, client_id, redirect_uri, code_challenge, code_challenge_method,
		     resource, scope, access_token, expires_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		c.Code, c.ClientID, c.RedirectURI, c.CodeChallenge, c.CodeChallengeMethod,
		c.Resource, c.Scope, c.AccessToken, c.ExpiresAt)
	return err
}

// ConsumeOAuthCode deletes the row and returns it. A missing or expired code
// is pgx.ErrNoRows.
func ConsumeOAuthCode(ctx context.Context, tx pgx.Tx, code string) (*OAuthCode, error) {
	var c OAuthCode
	err := tx.QueryRow(ctx, `
		DELETE FROM oauth_codes
		 WHERE code = $1 AND expires_at > now()
		 RETURNING code, client_id, redirect_uri, code_challenge, code_challenge_method,
		           resource, scope, access_token, expires_at`, code).
		Scan(&c.Code, &c.ClientID, &c.RedirectURI, &c.CodeChallenge, &c.CodeChallengeMethod,
			&c.Resource, &c.Scope, &c.AccessToken, &c.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return &c, nil
}
