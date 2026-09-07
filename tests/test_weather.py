import sys
import unittest
from datetime import date
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from update_weather import heat_index, daily_rows

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

if __name__ == '__main__':
    unittest.main()
