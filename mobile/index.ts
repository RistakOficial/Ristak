import { registerRootComponent } from 'expo';

import App from './App';
// Defines the iOS background-refresh task at module scope so it can run on a
// headless background launch (see src/background.ts).
import './src/background';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
