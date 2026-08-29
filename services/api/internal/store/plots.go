package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ojardila/bascula/services/api/internal/domain"
)

// PlotCrop is a crop planted in a plot. Labors point here and not at the plot:
// if a plot has coffee and plantain, "how did the coffee do" is only
// answerable at this grain.
type PlotCrop struct {
	ID     string `json:"id"`
	PlotID string `json:"plotId"`
	// CropTypeID and VarietyID are the catalogue rows. CropType and Variety
	// are their names: a caller may send either, and a name that is not in the
	// catalogue yet is added to it rather than rejected, which is the
	// "add it if it is not there" button RSP-001 asks for.
	CropTypeID string     `json:"cropTypeId"`
	CropType   string     `json:"cropType"`
	VarietyID  *string    `json:"varietyId"`
	Variety    *string    `json:"variety"`
	AreaHa     *float64   `json:"areaHa"`
	PlantedOn  *time.Time `json:"plantedOn"`
	RemovedOn  *time.Time `json:"removedOn"`
	DeletedAt  *time.Time `json:"deletedAt"`
}

// Plot is a parcel. `boundary` exists in the schema from the first migration
// but sprint 1 exposes no endpoint that writes it: AreaHaGIS therefore comes
// back null until the map screen lands. Declared and computed hectares are
// both returned, always: they disagree, and hiding one decides for the owner
// which one lies.
type Plot struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	AreaHa       *float64   `json:"areaHa"`
	AreaHaGIS    *float64   `json:"computedAreaHa"`
	Department   *string    `json:"department"`
	Municipality *string    `json:"municipality"`
	CreatedAt    time.Time  `json:"createdAt"`
	DeletedAt    *time.Time `json:"deletedAt"`
	Crops        []PlotCrop `json:"crops"`
}

const plotCols = `id::text, name, area_ha::float8, area_ha_gis::float8, department,
	municipality, created_at, deleted_at`

func scanPlot(row pgx.Row) (*Plot, error) {
	var p Plot
	err := row.Scan(&p.ID, &p.Name, &p.AreaHa, &p.AreaHaGIS, &p.Department,
		&p.Municipality, &p.CreatedAt, &p.DeletedAt)
	if err != nil {
		return nil, err
	}
	p.Crops = []PlotCrop{}
	return &p, nil
}

func ListPlots(ctx context.Context, tx pgx.Tx, includeDeleted bool) ([]Plot, error) {
	rows, err := tx.Query(ctx, `
		SELECT `+plotCols+` FROM plots
		 WHERE ($1 OR deleted_at IS NULL) ORDER BY name`, includeDeleted)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	plots := []Plot{}
	byID := map[string]int{}
	for rows.Next() {
		p, err := scanPlot(rows)
		if err != nil {
			return nil, err
		}
		byID[p.ID] = len(plots)
		plots = append(plots, *p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	crops, err := listCropsForFarm(ctx, tx, includeDeleted)
	if err != nil {
		return nil, err
	}
	for _, c := range crops {
		if i, ok := byID[c.PlotID]; ok {
			plots[i].Crops = append(plots[i].Crops, c)
		}
	}
	return plots, nil
}

func listCropsForFarm(ctx context.Context, tx pgx.Tx, includeDeleted bool) ([]PlotCrop, error) {
	rows, err := tx.Query(ctx, `
		SELECT pc.id::text, pc.plot_id::text, pc.crop_type_id::text, ct.name,
		       pc.variety_id::text, v.name, pc.area_ha::float8,
		       pc.planted_on, pc.removed_on, pc.deleted_at
		  FROM plot_crops pc
		  JOIN crop_types ct ON ct.id = pc.crop_type_id
		  LEFT JOIN varieties v ON v.id = pc.variety_id
		 WHERE ($1 OR pc.deleted_at IS NULL) ORDER BY ct.name`, includeDeleted)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []PlotCrop{}
	for rows.Next() {
		var c PlotCrop
		if err := rows.Scan(&c.ID, &c.PlotID, &c.CropTypeID, &c.CropType,
			&c.VarietyID, &c.Variety, &c.AreaHa,
			&c.PlantedOn, &c.RemovedOn, &c.DeletedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func GetPlot(ctx context.Context, tx pgx.Tx, id string) (*Plot, error) {
	p, err := scanPlot(tx.QueryRow(ctx, `SELECT `+plotCols+` FROM plots WHERE id = $1`, id))
	if err != nil {
		return nil, err
	}
	crops, err := listCropsForFarm(ctx, tx, false)
	if err != nil {
		return nil, err
	}
	for _, c := range crops {
		if c.PlotID == p.ID {
			p.Crops = append(p.Crops, c)
		}
	}
	return p, nil
}

func CreatePlot(ctx context.Context, tx pgx.Tx, farmID string, p Plot, newID func() string) (*Plot, error) {
	out, err := scanPlot(tx.QueryRow(ctx, `
		INSERT INTO plots (id, farm_id, name, area_ha, department, municipality)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING `+plotCols,
		p.ID, farmID, p.Name, p.AreaHa, p.Department, p.Municipality))
	if err != nil {
		return nil, err
	}
	for _, c := range p.Crops {
		created, err := CreatePlotCrop(ctx, tx, farmID, out.ID, c, newID)
		if err != nil {
			return nil, err
		}
		out.Crops = append(out.Crops, *created)
	}
	return out, nil
}

// CreatePlotCrop resolves the crop type and variety through their catalogues
// first, creating the entry when the caller sent a name that is not there yet.
func CreatePlotCrop(ctx context.Context, tx pgx.Tx, farmID, plotID string, c PlotCrop, newID func() string) (*PlotCrop, error) {
	if c.CropTypeID == "" {
		if c.CropType == "" {
			return nil, domain.BadRequest("a crop needs cropTypeId or cropType")
		}
		item, err := EnsureCatalogItem(ctx, tx, CatalogCropTypes, farmID, newID(), c.CropType)
		if err != nil {
			return nil, err
		}
		c.CropTypeID = item.ID
	}
	if c.VarietyID == nil && c.Variety != nil && *c.Variety != "" {
		item, err := EnsureCatalogItem(ctx, tx, CatalogVarieties, farmID, newID(), *c.Variety)
		if err != nil {
			return nil, err
		}
		c.VarietyID = &item.ID
	}

	var out PlotCrop
	err := tx.QueryRow(ctx, `
		WITH ins AS (
			INSERT INTO plot_crops (id, farm_id, plot_id, crop_type_id, variety_id,
			                        area_ha, planted_on, removed_on)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			RETURNING *
		)
		SELECT pc.id::text, pc.plot_id::text, pc.crop_type_id::text, ct.name,
		       pc.variety_id::text, v.name, pc.area_ha::float8,
		       pc.planted_on, pc.removed_on, pc.deleted_at
		  FROM ins pc
		  JOIN crop_types ct ON ct.id = pc.crop_type_id
		  LEFT JOIN varieties v ON v.id = pc.variety_id`,
		c.ID, farmID, plotID, c.CropTypeID, c.VarietyID, c.AreaHa, c.PlantedOn, c.RemovedOn).
		Scan(&out.ID, &out.PlotID, &out.CropTypeID, &out.CropType, &out.VarietyID,
			&out.Variety, &out.AreaHa, &out.PlantedOn, &out.RemovedOn, &out.DeletedAt)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func UpdatePlot(ctx context.Context, tx pgx.Tx, id string, p Plot) (*Plot, error) {
	return scanPlot(tx.QueryRow(ctx, `
		UPDATE plots SET
			name         = coalesce($2, name),
			area_ha      = coalesce($3, area_ha),
			department   = coalesce($4, department),
			municipality = coalesce($5, municipality)
		 WHERE id = $1 AND deleted_at IS NULL
		 RETURNING `+plotCols,
		id, nilIfEmpty(p.Name), p.AreaHa, p.Department, p.Municipality))
}

// CountActiveCrops backs the PLOT_HAS_ACTIVE_CROPS conflict: a plot is not
// taken out of service while something is still planted in it.
func CountActiveCrops(ctx context.Context, tx pgx.Tx, plotID string) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
		SELECT count(*) FROM plot_crops WHERE plot_id = $1 AND deleted_at IS NULL`, plotID).Scan(&n)
	return n, err
}

func SoftDeletePlot(ctx context.Context, tx pgx.Tx, id string) error {
	tag, err := tx.Exec(ctx, `
		UPDATE plots SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return NoRows
	}
	return nil
}

func SoftDeletePlotCrop(ctx context.Context, tx pgx.Tx, plotID, cropID string) error {
	tag, err := tx.Exec(ctx, `
		UPDATE plot_crops SET deleted_at = now()
		 WHERE id = $1 AND plot_id = $2 AND deleted_at IS NULL`, cropID, plotID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return NoRows
	}
	return nil
}
