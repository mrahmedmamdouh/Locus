-- The three pilot malls in Muscat, with floor heights measured in the November 2026 field tests.
-- Boundaries are circles around the building; the radius covers the building and its car parks.
INSERT INTO malls (id, name, city, country, lat, lon, radius_m, entrance_floor_index, status, updated_at) VALUES
  ('mall-of-oman', 'Mall of Oman', 'Bawshar, Muscat', 'OM', 23.5718, 58.4045, 400, 0, 'pilot', '2026-11-13T00:00:00Z'),
  ('oman-avenues-mall', 'Oman Avenues Mall', 'Al Ghubrah, Muscat', 'OM', 23.5900, 58.4110, 300, 0, 'pilot', '2026-11-13T00:00:00Z'),
  ('city-centre-muscat', 'City Centre Muscat', 'Seeb, Muscat', 'OM', 23.5994, 58.2478, 350, 0, 'pilot', '2026-11-13T00:00:00Z');

-- Mall of Oman: measured 5.75 m per floor (31 Oct and 13 Nov). The mall calls the entrance level "Level 1".
INSERT INTO floors (mall_id, floor_index, label, z_min_m, z_max_m) VALUES
  ('mall-of-oman', 0, 'Level 1', -2.875, 2.875),
  ('mall-of-oman', 1, 'Level 2', 2.875, 8.625),
  ('mall-of-oman', 2, 'Level 3', 8.625, 14.375),
  ('oman-avenues-mall', -1, 'Lower Ground', -8.625, -2.875),
  ('oman-avenues-mall', 0, 'Ground', -2.875, 2.875),
  ('oman-avenues-mall', 1, 'First', 2.875, 8.625),
  ('oman-avenues-mall', 2, 'Second', 8.625, 14.375),
  ('oman-avenues-mall', 3, 'Third', 14.375, 20.125),
  ('city-centre-muscat', 0, 'Ground', -2.9, 2.9),
  ('city-centre-muscat', 1, 'First', 2.9, 8.7);
