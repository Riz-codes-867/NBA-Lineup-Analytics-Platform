/** One player inside a lineup. */
export interface LineupPlayer {
  player_id: string;
  name: string;
}

/**
 * One row returned by GET /api/v1/lineups.
 * `offensive_*` = what the lineup did with the ball; `defensive_*` = what opponents did against it.
 * Only the fields the UI uses are listed by name; the index signature covers the other raw totals.
 */
export interface Lineup {
  team_id: string;
  team_name: string;
  player_ids: string[];
  players: LineupPlayer[];

  offensive_possessions: number;
  defensive_possessions: number;
  total_possessions: number;
  offensive_points: number;
  defensive_points: number;

  offensive_rating: number;
  defensive_rating: number;
  net_rating: number;
  plus_minus: number;
  offensive_efg_pct: number;
  defensive_efg_pct: number;
  offensive_tov_pct: number;
  defensive_tov_pct: number;
  oreb_pct: number;
  dreb_pct: number;

  [stat: string]: unknown;
}

/** Query params supported by the lineups endpoint. Undefined/empty values are not sent. */
export interface LineupQuery {
  lineup_size?: number;
  team_id?: string | null;
  player_id?: string | null;
  min_possessions?: number;
  sort_by?: string;
  order?: 'asc' | 'desc';
}
