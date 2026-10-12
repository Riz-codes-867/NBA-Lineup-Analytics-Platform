"""Tests for the lineup summary helper and API.

Uses a tiny hand-built league so every expected number can be checked on paper:

    Team A (players a1-a5) vs Team B (players b1-b5), 3 possessions:
      1. A on offense: made 3-pointer            -> A scores 3
      2. B on offense: missed 2, A grabs DREB    -> B scores 0
      3. A on offense: turnover                  -> A scores 0

    A's 5-man lineup: 2 offensive poss (3 pts), 1 defensive poss (0 pts allowed)
    B's 5-man lineup: 1 offensive poss (0 pts), 2 defensive poss (3 pts allowed)
"""
import uuid
from datetime import date

from django.test import TestCase

from app.helpers.lineups import STAT_FIELDS, get_lineup_league_summary_stats
from app.models import Game, Player, Possession, Team


def _possession(game, offense, defense, off_ids, def_ids, **stats):
    """Create a possession with every counting stat defaulting to 0."""
    values = {field: 0 for field in STAT_FIELDS}
    values.update(stats)
    return Possession.objects.create(
        id=uuid.uuid4(),
        game=game,
        offensive_team=offense,
        defensive_team=defense,
        offensive_player_ids=off_ids,
        defensive_player_ids=def_ids,
        period=1,
        seconds=10.0,
        **values,
    )


class LineupSummaryTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.team_a = Team.objects.create(id=uuid.uuid4(), name='Team A')
        cls.team_b = Team.objects.create(id=uuid.uuid4(), name='Team B')
        cls.a_ids = [Player.objects.create(id=uuid.uuid4(), team=cls.team_a, name=f'a{i}').id for i in range(5)]
        cls.b_ids = [Player.objects.create(id=uuid.uuid4(), team=cls.team_b, name=f'b{i}').id for i in range(5)]
        game = Game.objects.create(id=uuid.uuid4(), date=date(2025, 10, 22))

        # 1. A made 3-pointer
        _possession(game, cls.team_a, cls.team_b, cls.a_ids, cls.b_ids,
                    fg3_made=1, fg3_attempted=1, fg_made=1, fg_attempted=1,
                    shot_attempts=1, shot_attempt_points=3, points=3)
        # 2. B missed 2, A defensive rebound
        _possession(game, cls.team_b, cls.team_a, cls.b_ids, cls.a_ids,
                    fg2_attempted=1, fg_attempted=1, shot_attempts=1,
                    rebounds_defense=1, rebound_opportunities=1)
        # 3. A turnover
        _possession(game, cls.team_a, cls.team_b, cls.a_ids, cls.b_ids, turnovers=1)

    def _lineup_for(self, results, team):
        return next(r for r in results if r['team_id'] == str(team.id))

    def test_five_man_totals(self):
        results = get_lineup_league_summary_stats(lineup_size=5)
        self.assertEqual(len(results), 2)

        a = self._lineup_for(results, self.team_a)
        self.assertEqual(a['offensive_possessions'], 2)
        self.assertEqual(a['defensive_possessions'], 1)
        self.assertEqual(a['total_possessions'], 3)
        self.assertEqual(a['offensive_points'], 3)
        self.assertEqual(a['defensive_points'], 0)
        self.assertEqual(a['offensive_turnovers'], 1)
        self.assertEqual(a['defensive_rebounds_defense'], 1)
        self.assertEqual(a['team_name'], 'Team A')
        self.assertEqual(sorted(p['name'] for p in a['players']), ['a0', 'a1', 'a2', 'a3', 'a4'])

    def test_response_has_every_sample_key(self):
        import json
        from pathlib import Path
        sample_path = Path(__file__).resolve().parent.parent / 'helpers' / 'sample_summary_data' / 'sample_summary_data.json'
        sample_keys = set(json.loads(sample_path.read_text())[0])
        for record in get_lineup_league_summary_stats(lineup_size=5):
            self.assertTrue(sample_keys <= set(record), sample_keys - set(record))

    def test_advanced_metrics(self):
        results = get_lineup_league_summary_stats(lineup_size=5)
        a = self._lineup_for(results, self.team_a)
        b = self._lineup_for(results, self.team_b)

        self.assertEqual(a['offensive_rating'], 150.0)   # 3 pts / 2 poss * 100
        self.assertEqual(a['defensive_rating'], 0.0)     # 0 pts / 1 poss
        self.assertEqual(a['net_rating'], 150.0)
        self.assertEqual(a['plus_minus'], 3)
        self.assertEqual(a['offensive_efg_pct'], 1.5)    # (1 FGM + 0.5 * 1 3PM) / 1 FGA
        self.assertEqual(a['offensive_tov_pct'], 0.5)    # 1 TO / 2 poss
        self.assertEqual(a['dreb_pct'], 1.0)             # 1 DREB / 1 opportunity
        self.assertEqual(a['oreb_pct'], 0)               # no offensive rebound chances -> 0, not a crash

        self.assertEqual(b['net_rating'], -150.0)
        self.assertEqual(b['defensive_tov_pct'], 0.5)    # forced 1 TO in 2 defensive poss

    def test_lineup_size_one_gives_one_row_per_player(self):
        results = get_lineup_league_summary_stats(lineup_size=1)
        self.assertEqual(len(results), 10)
        self.assertTrue(all(len(r['players']) == 1 for r in results))
        # every possession credits 5 players on offense
        self.assertEqual(sum(r['offensive_possessions'] for r in results), 3 * 5)

    def test_filters(self):
        only_a = get_lineup_league_summary_stats(lineup_size=5, team_id=str(self.team_a.id))
        self.assertEqual([r['team_name'] for r in only_a], ['Team A'])

        with_b0 = get_lineup_league_summary_stats(lineup_size=2, player_id=str(self.b_ids[0]))
        self.assertEqual(len(with_b0), 4)  # b0 paired with each of 4 teammates
        self.assertTrue(all(str(self.b_ids[0]) in r['player_ids'] for r in with_b0))

        self.assertEqual(len(get_lineup_league_summary_stats(lineup_size=5, min_possessions=3)), 2)
        self.assertEqual(len(get_lineup_league_summary_stats(lineup_size=5, min_possessions=4)), 0)

    def test_sorting(self):
        desc = get_lineup_league_summary_stats(lineup_size=5, sort_by='net_rating')
        self.assertEqual(desc[0]['team_name'], 'Team A')
        asc = get_lineup_league_summary_stats(lineup_size=5, sort_by='net_rating', order='asc')
        self.assertEqual(asc[0]['team_name'], 'Team B')
        # an unknown sort field falls back instead of crashing
        self.assertEqual(len(get_lineup_league_summary_stats(lineup_size=5, sort_by='not_a_field')), 2)

    def test_api_endpoint(self):
        response = self.client.get('/api/v1/lineups', {'lineup_size': 1, 'sort_by': 'net_rating'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 10)

        # bad input is clamped / ignored rather than erroring
        response = self.client.get('/api/v1/lineups', {'lineup_size': 'abc', 'min_possessions': -5})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 2)
