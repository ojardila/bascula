// Command cfhostname creates or checks the Cloudflare for SaaS custom
// hostname (and so the edge certificate) of one farm address, by hand.
//
//	CF_SAAS_TOKEN=… CF_ZONE_ID=… go run ./cmd/cfhostname check  sanjose.bascula.engp.io
//	CF_SAAS_TOKEN=… CF_ZONE_ID=… go run ./cmd/cfhostname create sanjose.bascula.engp.io
//	CF_SAAS_TOKEN=… CF_ZONE_ID=… go run ./cmd/cfhostname wait   sanjose.bascula.engp.io
//
// check only reads. create is idempotent: it finds the hostname first and
// creates it only when missing. wait creates if needed and polls every 10 s
// until the hostname and its certificate are active (or 15 minutes pass).
// CF_SAAS_DCV_METHOD=txt asks for TXT validation and prints the records.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/ojardila/bascula/services/api/internal/cfsaas"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "cfhostname:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) != 2 {
		return errors.New("usage: cfhostname check|create|wait <hostname>")
	}
	cmd, host := args[0], strings.ToLower(strings.TrimSpace(args[1]))
	c := &cfsaas.Client{
		Token:   os.Getenv("CF_SAAS_TOKEN"),
		ZoneID:  os.Getenv("CF_ZONE_ID"),
		BaseURL: os.Getenv("CF_API_URL"),
		Method:  os.Getenv("CF_SAAS_DCV_METHOD"),
	}
	if !c.Enabled() {
		return errors.New("set CF_SAAS_TOKEN and CF_ZONE_ID")
	}
	ctx := context.Background()
	switch cmd {
	case "check":
		h, err := c.Find(ctx, host)
		if err != nil {
			return err
		}
		if h == nil {
			fmt.Println(host + ": no custom hostname yet")
			return nil
		}
		show(h)
		return nil
	case "create":
		h, err := c.Ensure(ctx, host)
		if err != nil {
			return err
		}
		show(h)
		return nil
	case "wait":
		h, err := c.Ensure(ctx, host)
		if err != nil {
			return err
		}
		deadline := time.Now().Add(15 * time.Minute)
		for !h.Active() && !h.Failed() && time.Now().Before(deadline) {
			show(h)
			time.Sleep(10 * time.Second)
			if h, err = c.Get(ctx, h.ID); err != nil {
				return err
			}
		}
		show(h)
		if !h.Active() {
			return errors.New("not active")
		}
		return nil
	}
	return fmt.Errorf("unknown command %q", cmd)
}

func show(h *cfsaas.Hostname) {
	fmt.Println(time.Now().Format("15:04:05"), h.Summary())
	if h.OwnershipVerification != nil && h.Status != "active" && h.OwnershipVerification.Name != "" {
		fmt.Printf("  ownership TXT %s = %s\n", h.OwnershipVerification.Name, h.OwnershipVerification.Value)
	}
	for _, r := range h.SSL.ValidationRecords {
		if r.TXTName != "" {
			fmt.Printf("  certificate TXT %s = %s (%s)\n", r.TXTName, r.TXTValue, r.Status)
		}
		if r.HTTPURL != "" {
			fmt.Printf("  certificate HTTP %s -> %s (%s)\n", r.HTTPURL, r.HTTPBody, r.Status)
		}
	}
}
