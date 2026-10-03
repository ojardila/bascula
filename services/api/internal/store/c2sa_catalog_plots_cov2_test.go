// SPDX-License-Identifier: MIT

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

func c2saWantCode(t *testing.T, what string, err error, status int, code domain.Code) *domain.Error {
	t.Helper()
	de, ok := domain.AsError(err)
	if !ok || de.Status != status || de.Code != code {
		t.Fatalf("%s: got %v, want %d %s", what, err, status, code)
	}
	return de
}

func TestC2saCatalogs(t *testing.T) {
	ctx := context.Background()

	if _, err := ListCatalog(ctx, &cmrTx{}, Catalog("nope")); err == nil {
		t.Error("ListCatalog accepted an unknown catalog")
	}
	if _, err := EnsureCatalogItem(ctx, &cmrTx{}, Catalog("nope"), "f", "id", "x"); err == nil {
		t.Error("EnsureCatalogItem accepted an unknown catalog")
	}

	tx := &cmrTx{query: map[string]*cmrRows{"FROM crop_types WHERE deleted_at IS NULL": {
		data: [][]any{{"c1", "Cafe"}, {"c2", "Platano"}},
	}}}
	items, err := ListCatalog(ctx, tx, CatalogCropTypes)
	if err != nil || len(items) != 2 || items[0] != (CatalogItem{ID: "c1", Name: "Cafe"}) ||
		items[1].Name != "Platano" {
		t.Fatalf("ListCatalog = %v, %v", items, err)
	}

	for _, rows := range []*cmrRows{cmrFailing(), cmrEndsBadly()} {
		tx = &cmrTx{query: map[string]*cmrRows{"FROM crop_types WHERE deleted_at IS NULL": rows}}
		items, err = ListCatalog(ctx, tx, CatalogCropTypes)
		cmrWantErr(t, "ListCatalog", err)
		if rows.scanErr != nil && items != nil {
			t.Errorf("ListCatalog returned rows with a scan error: %v", items)
		}
	}
}

const (
	c2saPlotListSQL  = "coalesce(municipality, '') ILIKE"
	c2saPlotCropsSQL = "WHERE ($1 OR pc.deleted_at IS NULL)"
)

func TestC2saPlotsPassFailuresThrough(t *testing.T) {
	ctx := context.Background()

	tx := &cmrTx{query: map[string]*cmrRows{"ST_Intersects": cmrFailing()}}
	_, err := OverlappingPlots(ctx, tx, "p1")
	cmrWantErr(t, "OverlappingPlots", err)

	tx = &cmrTx{query: map[string]*cmrRows{c2saPlotListSQL: cmrFailing()}}
	_, err = ListPlots(ctx, tx, Filter{})
	cmrWantErr(t, "ListPlots scan", err)

	tx = &cmrTx{query: map[string]*cmrRows{c2saPlotListSQL: cmrEndsBadly()}}
	_, err = ListPlots(ctx, tx, Filter{})
	cmrWantErr(t, "ListPlots iteration", err)

	tx = &cmrTx{query: map[string]*cmrRows{c2saPlotCropsSQL: cmrFailing()}}
	_, err = listCropsForFarm(ctx, tx, false)
	cmrWantErr(t, "listCropsForFarm", err)

	// A row that is gone (or was never there) is NoRows, not success.
	tx = &cmrTx{exec: map[string]error{"UPDATE plots SET deleted_at = now()": nil}}
	if err := SoftDeletePlot(ctx, tx, "p1"); !errors.Is(err, NoRows) {
		t.Errorf("SoftDeletePlot of nothing: %v, want NoRows", err)
	}
	tx = &cmrTx{exec: map[string]error{"UPDATE plot_crops SET deleted_at = now()": nil}}
	if err := SoftDeletePlotCrop(ctx, tx, "p1", "c1"); !errors.Is(err, NoRows) {
		t.Errorf("SoftDeletePlotCrop of nothing: %v, want NoRows", err)
	}
}

func TestC2saGetPlotCropAndCropWithoutType(t *testing.T) {
	ctx := context.Background()
	planted := time.Date(2025, 3, 1, 0, 0, 0, 0, time.UTC)
	tx := &cmrTx{row: map[string]cmrRow{"WHERE pc.id = $1": {vals: []any{
		"c1", "p1", "ct1", "Cafe", c2saS("v1"), c2saS("Castillo"), c2saF(1.5), &planted,
	}}}}
	c, err := GetPlotCrop(ctx, tx, "c1")
	if err != nil {
		t.Fatalf("GetPlotCrop: %v", err)
	}
	if c.ID != "c1" || c.PlotID != "p1" || c.CropType != "Cafe" || *c.Variety != "Castillo" ||
		*c.AreaHa != 1.5 || !c.PlantedOn.Equal(planted) || c.RemovedOn != nil {
		t.Errorf("GetPlotCrop = %+v", c)
	}

	// Neither an id nor a name: refused before anything is written.
	_, err = CreatePlotCrop(ctx, &cmrTx{}, "f", "p1", PlotCrop{}, func() string { return "x" })
	c2saWantCode(t, "crop without a type", err, 400, domain.CodeBadRequest)
}
