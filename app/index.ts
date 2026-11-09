import { registerRootComponent } from 'expo';

// Defines the background geofence task at module scope (must happen before the app registers).
import './src/native/autoGeofence';
import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
