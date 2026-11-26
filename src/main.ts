import './styles.css';
import './styles-gamepad.css';
import './styles-touch.css';
import { GameApp } from './app';

let activeApp: GameApp | null = null;

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    throw new Error('Krunked Cells: missing #game-canvas element in index.html');
  }
  activeApp = new GameApp(canvas);
  await activeApp.init();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      void bootstrap();
    });
  } else {
    void bootstrap();
  }
}

export { activeApp };
