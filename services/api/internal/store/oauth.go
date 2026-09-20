package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// OAuthClient is a dynamically registered public client (RFC 7591). ChatGPT
// and similar hosts register themselves; they have no client secret.
type OAuthClient struct {
	ID           string
	Name         string
	RedirectURIs []string
}

func InsertOAuthClient(ctx context.Context, tx pgx.Tx, c OAuthClient) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO oauth_clients (id, name, redirect_uris)
		     VALUES ($1, $2, $3)`, c.ID, c.Name, c.RedirectURIs)
	return err
}

func GetOAuthClient(ctx context.Context, tx pgx.Tx, id string) (*OAuthClient, error) {
	var c OAuthClient
	err := tx.QueryRow(ctx, `
		SELECT id, name, redirect_uris FROM oauth_clients WHERE id = $1`, id).
		Scan(&c.ID, &c.Name, &c.RedirectURIs)
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
	AccessToken         string
	ExpiresAt           time.Time
}

func InsertOAuthCode(ctx context.Context, tx pgx.Tx, c OAuthCode) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO oauth_codes
		    (code, client_id, redirect_uri, code_challenge, code_challenge_method,
		     resource, access_token, expires_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		c.Code, c.ClientID, c.RedirectURI, c.CodeChallenge, c.CodeChallengeMethod,
		c.Resource, c.AccessToken, c.ExpiresAt)
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
		           resource, access_token, expires_at`, code).
		Scan(&c.Code, &c.ClientID, &c.RedirectURI, &c.CodeChallenge, &c.CodeChallengeMethod,
			&c.Resource, &c.AccessToken, &c.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return &c, nil
}
