import { AV_LOG_WARNING } from 'node-av/constants';
import { Log } from 'node-av/lib';

// encoder statistics at info level would bury the test output
Log.setLevel(AV_LOG_WARNING);
