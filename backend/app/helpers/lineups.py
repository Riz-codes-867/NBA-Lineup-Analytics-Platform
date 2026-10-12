from __future__ import annotations

"""Helpers for the lineup summary API."""

from collections import defaultdict
from itertools import combinations
from typing import Any

from app.models import Player, Possession, Team

LineupRecord = dict[str, Any]

# Counting stats recorded on every possession (period/seconds excluded).
STAT_FIELDS = [
    'fg2_made',
    'fg2_attempted',
    'fg3_made',
    'fg3_attempted',
    'fg_made',
    'fg_attempted',
    'ft_made',
    'ft_attempted',
    'rebounds_offense',
    'rebounds_defense',
    'rebound_opportunities',
    'assists',
    'steals',
    'turnovers',
    'blocks',
    'offensive_fouls',
    'defensive_fouls',
    'shooting_fouls',
    'points',
    'shot_attempts',
    'shot_attempt_points',
    'ft_potential_points',
    'transition_take_fouls',
]


def _normalize_lineup_size(lineup_size: Any) -> int:
    try:
        normalized_lineup_size = int(lineup_size)
    except (TypeError, ValueError):
        return 5

    return max(1, min(5, normalized_lineup_size))


def _safe_div(numerator: float, denominator: float) -> float:
    """Divide, returning 0 instead of raising when the denominator is 0."""
    return numerator / denominator if denominator else 0


def _add_advanced_metrics(record: LineupRecord) -> None:
    """Add per-possession metrics so lineups with different minutes can be compared fairly.

    Offense = what this lineup did with the ball; defense = what opponents did against it.
    """
    off_poss = record['offensive_possessions']
    def_poss = record['defensive_possessions']

    # Points per 100 possessions. Net rating is the headline "is this lineup winning?" number.
    record['offensive_rating'] = round(_safe_div(record['offensive_points'], off_poss) * 100, 1)
    record['defensive_rating'] = round(_safe_div(record['defensive_points'], def_poss) * 100, 1)
    record['net_rating'] = round(record['offensive_rating'] - record['defensive_rating'], 1)
    record['plus_minus'] = record['offensive_points'] - record['defensive_points']

    # Effective FG% gives 3-pointers 1.5x credit: (FGM + 0.5 * 3PM) / FGA.
    for side in ('offensive', 'defensive'):
        record[f'{side}_efg_pct'] = round(_safe_div(
            record[f'{side}_fg_made'] + 0.5 * record[f'{side}_fg3_made'],
            record[f'{side}_fg_attempted'],
        ), 3)

    # Turnovers per possession: our giveaways (offense) and turnovers we force (defense).
    record['offensive_tov_pct'] = round(_safe_div(record['offensive_turnovers'], off_poss), 3)
    record['defensive_tov_pct'] = round(_safe_div(record['defensive_turnovers'], def_poss), 3)

    # Rebounding share of available boards: OREB% on our misses, DREB% on opponents' misses.
    record['oreb_pct'] = round(_safe_div(
        record['offensive_rebounds_offense'], record['offensive_rebound_opportunities'],
    ), 3)
    record['dreb_pct'] = round(_safe_div(
        record['defensive_rebounds_defense'], record['defensive_rebound_opportunities'],
    ), 3)


def get_lineup_league_summary_stats(
    lineup_size: int = 5,
    team_id: str | None = None,
    player_id: str | None = None,
    min_possessions: int = 0,
    sort_by: str = 'total_possessions',
    order: str = 'desc',
) -> list[LineupRecord]:
    """Return lineup summaries across the entire league.

    Optional filters: only one team's lineups (team_id), only lineups containing a player
    (player_id), and only lineups with at least min_possessions total possessions.
    Results are sorted by any numeric field (sort_by) in 'asc' or 'desc' order.
    """
    # Step 1: load every possession (one query) and a player id -> name lookup.
    possessions = list(
        Possession.objects.values(
            'offensive_team_id',
            'defensive_team_id',
            'offensive_player_ids',
            'defensive_player_ids',
            *STAT_FIELDS,
        )
    )
    player_names = {str(row['id']): row['name'] for row in Player.objects.values('id', 'name')}
    team_names = {str(row['id']): row['name'] for row in Team.objects.values('id', 'name')}

    # Step 2-3: credit every n-player combination on the floor with the possession's stats.
    # lineup_totals[(team_id, (player_id, ...))] -> {'offensive_points': 12, 'defensive_points': 9, ...}
    lineup_totals = defaultdict(lambda: defaultdict(int))

    for possession in possessions:
        # --- offense ---
        offense_team = str(possession['offensive_team_id'])
        offense_ids = sorted(str(x) for x in possession['offensive_player_ids'])
        for combo in combinations(offense_ids, lineup_size):
            key = (offense_team, combo)
            lineup_totals[key]['offensive_possessions'] += 1
            for field in STAT_FIELDS:
                lineup_totals[key][f'offensive_{field}'] += possession[field]

        # --- defense ---
        defense_team = str(possession['defensive_team_id'])
        defense_ids = sorted(str(x) for x in possession['defensive_player_ids'])
        for combo in combinations(defense_ids, lineup_size):
            key = (defense_team, combo)
            lineup_totals[key]['defensive_possessions'] += 1
            for field in STAT_FIELDS:
                lineup_totals[key][f'defensive_{field}'] += possession[field]

    # Step 4: build one response record per lineup, matching sample_summary_data.json
    results: list[LineupRecord] = []
    for (lineup_team_id, player_ids), totals in lineup_totals.items():
        # filters: skip lineups the caller didn't ask for
        if team_id and lineup_team_id != team_id:
            continue
        if player_id and player_id not in player_ids:
            continue

        record: LineupRecord = {}

        # offense totals (missing keys read as 0 thanks to defaultdict)
        record['offensive_possessions'] = totals['offensive_possessions']
        for field in STAT_FIELDS:
            record[f'offensive_{field}'] = totals[f'offensive_{field}']

        # defense totals (what the opponent did while this lineup defended)
        record['defensive_possessions'] = totals['defensive_possessions']
        for field in STAT_FIELDS:
            record[f'defensive_{field}'] = totals[f'defensive_{field}']

        record['total_possessions'] = record['offensive_possessions'] + record['defensive_possessions']

        # shooting percentages, e.g. offensive_fg2_pct = offensive_fg2_made / offensive_fg2_attempted
        for side in ('offensive', 'defensive'):
            for shot in ('fg', 'fg2', 'fg3'):
                record[f'{side}_{shot}_pct'] = _safe_div(
                    record[f'{side}_{shot}_made'],
                    record[f'{side}_{shot}_attempted'],
                )

        if record['total_possessions'] < min_possessions:
            continue

        _add_advanced_metrics(record)

        # identity
        record['team_id'] = lineup_team_id
        record['team_name'] = team_names.get(lineup_team_id, '')
        record['player_ids'] = list(player_ids)
        record['players'] = [
            {'player_id': player_id, 'name': player_names[player_id]}
            for player_id in player_ids
        ]

        results.append(record)

    # sort by any numeric field; fall back to most-used lineups first
    if not results or not isinstance(results[0].get(sort_by), (int, float)):
        sort_by = 'total_possessions'
    results.sort(key=lambda r: r[sort_by], reverse=(order != 'asc'))
    return results
