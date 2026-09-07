import sys
import unittest
from datetime import date
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from update_weather import heat_index, daily_rows, build_region_rows

class WeatherTests(unittest.TestCase):
    def test_nws_reference_values(self):
        self.assertAlmostEqual(heat_index(90, 70), 105.92, places=2)
        self.assertAlmostEqual(heat_index(100, 40), 109.26, places=2)
        self.assertAlmostEqual(heat_index(80, 40), 79.79, places=2)
        self.assertAlmostEqual(heat_index(100, 10), 94.12, places=2)
        self.assertAlmostEqual(heat_index(85, 90), 101.78, places=2)

    def test_local_days_hourly_weighting_and_paired_humidity(self):
        text = ('station,valid,tmpf,relh\n'
                'BTR,2023-08-01 04:53,70,90\n'  # preceding local day
                'BTR,2023-08-01 05:15,80,70\n'
                'BTR,2023-08-01 05:55,90,70\n'  # replaces earlier same hour
                'BTR,2023-08-01 06:55,100,M\n'  # temp without RH
                'BTR,2023-08-01 07:55,M,50\n'
                'BTR,2023-08-02 04:55,80,40\n'  # still Aug 1 locally
                'BTR,2023-08-02 05:55,110,40\n')
        rows = daily_rows(text,date(2023,8,1),date(2023,8,2),['KBTR','KHUM'])
        btr, hum = rows
        self.assertEqual((btr['high_f'],btr['low_f'],btr['average_f']), (100,80,90))
        self.assertEqual((btr['temperature_hours'],btr['heat_index_hours']), (3,2))
        self.assertEqual(btr['peak_heat_index_f'],105.9)
        self.assertEqual(btr['morning_low_f'],80)
        self.assertEqual(btr['hi_hours_105'],1)
        self.assertEqual(btr['hi_hours_108'],0)
        self.assertEqual(hum['high_f'],'')
        self.assertEqual(hum['temperature_hours'],0)

    def test_dst_expected_hours_and_duplicate_local_hour(self):
        text = 'station,valid,tmpf,relh\nBTR,2023-11-05 06:53,75,70\nBTR,2023-11-05 07:53,74,70\n'
        fall = daily_rows(text,date(2023,11,5),date(2023,11,6),['KBTR'])[0]
        self.assertEqual(fall['temperature_hours'],2)
        self.assertEqual(fall['expected_hours'],25)
        spring = daily_rows('station,valid,tmpf,relh\n',date(2023,3,12),date(2023,3,13),['KBTR'])[0]
        self.assertEqual(spring['expected_hours'],23)

    def test_reject_bad_response(self):
        with self.assertRaises(ValueError):
            daily_rows('<html>Error</html>', date(2023,1,1),date(2023,1,2),['KBTR'])

    def test_regional_primary_fallback_and_persistence(self):
        cfg = {
            'regions': {
                '3': {'weather_stations':['KHUM'], 'weather_fallback_stations':['KGAO']}
            },
            'parishes': [
                {'name':'A','region':'3','population_2020':1000}
            ]
        }
        rows = []
        for d, hum_hours, gao_hi in [
            ('2024-07-01', 2, 109),
            ('2024-07-02', 2, 110),
            ('2024-07-03', 24, 111),
        ]:
            rows.append({'date':d,'station':'KHUM','high_f':95,'low_f':75,'average_f':85,
                         'peak_heat_index_f':111,'morning_low_f':76,'hi_hours_105':6,'hi_hours_108':3,
                         'temperature_hours':hum_hours,'heat_index_hours':hum_hours,'expected_hours':24})
            rows.append({'date':d,'station':'KGAO','high_f':94,'low_f':76,'average_f':84,
                         'peak_heat_index_f':gao_hi,'morning_low_f':77,'hi_hours_105':5,'hi_hours_108':2,
                         'temperature_hours':24,'heat_index_hours':24,'expected_hours':24})
        regional = build_region_rows(rows,cfg)
        self.assertEqual(regional[0]['weather_sources'],'KGAO')
        self.assertEqual(regional[0]['fallback_used'],1)
        self.assertEqual(regional[1]['consecutive_hi108_days'],2)
        self.assertEqual(regional[2]['weather_sources'],'KHUM')
        self.assertEqual(regional[2]['fallback_used'],0)
        self.assertEqual(regional[2]['hi_3day_mean_f'],'110.0')

if __name__ == '__main__':
    unittest.main()
