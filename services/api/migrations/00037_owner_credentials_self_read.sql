-- +goose Up
-- +goose StatementBegin

-- A farm registered with an address that already had an account keeps its
-- own owner password in farm_owner_credentials (00032). Sign-in on the shared
-- platform now checks that password for that farm, instead of the account's
-- global one: whoever registered an address first (without proving it was
-- theirs) must not open a farm the address's real owner registered later.
-- Sign-in happens before a farm is chosen, so the person has to be able to
-- read their own rows, the same way memberships allows it (00008).
DROP POLICY p_farm_owner_credentials ON farm_owner_credentials;
CREATE POLICY p_farm_owner_credentials ON farm_owner_credentials
  USING (farm_id = current_farm() OR user_id = current_user_id())
  WITH CHECK (farm_id = current_farm());

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP POLICY p_farm_owner_credentials ON farm_owner_credentials;
CREATE POLICY p_farm_owner_credentials ON farm_owner_credentials
  USING (farm_id = current_farm())
  WITH CHECK (farm_id = current_farm());
-- +goose StatementEnd
