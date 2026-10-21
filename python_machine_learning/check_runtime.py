"""JSON report of the actual graph-training and checkpoint probe."""
import argparse
import json
import sys

from device_runtime import BACKENDS, environment_report, select_device


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--backend', choices=('auto',) + BACKENDS, default='auto')
    args = parser.parse_args()
    try:
        device, info = select_device(args.backend)
        print(json.dumps({'status': 'PASS', **environment_report(device, info)}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'status': 'FAIL', 'error': str(error)}, ensure_ascii=False))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
