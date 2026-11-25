import type { BossDef, BossId } from '../contracts';

export const BOSSES: readonly BossDef[] = [
  {
    id: 'Behemoth',
    cdbId: 'Behemoth',
    name: 'The Iron Concierge',
    subtitle: 'Warden of the Black Bridge',
    biomeId: 'Bridge',
    baseHp: 4000,
    baseDamage: 22,
    width: 36,
    height: 52,
    phases: [
      {
        hpThreshold: 1.0,
        name: 'Brute Awoken',
        speedMult: 1.0,
        attacks: ['punch', 'shockwave', 'roarAura'],
      },
      {
        hpThreshold: 0.66,
        name: 'Crimson Laceration',
        speedMult: 1.18,
        attacks: ['punch', 'leapSlam', 'shockwave', 'roarAura'],
      },
      {
        hpThreshold: 0.33,
        name: 'Unchained Fury',
        speedMult: 1.38,
        attacks: ['leapSlam', 'shockwave', 'roarAura', 'punch'],
      },
    ],
    cellReward: 25,
    goldReward: 400,
    spriteKey: 'boss_Behemoth',
  },
  {
    id: 'TimeKeeper',
    cdbId: 'TimeKeeper',
    name: 'The Chrono Warden',
    subtitle: 'Mistress of the Clock Room',
    biomeId: 'TopClockTower',
    baseHp: 2500,
    baseDamage: 24,
    width: 24,
    height: 36,
    phases: [
      {
        hpThreshold: 1.0,
        name: 'Ticking Precision',
        speedMult: 1.0,
        attacks: ['swordCombo', 'shurikenFan', 'dashSlash', 'hookPull'],
      },
      {
        hpThreshold: 0.7,
        name: 'Shattered Pendulum',
        speedMult: 1.2,
        attacks: ['swordCombo', 'shurikenFan', 'hookPull', 'dashSlash', 'fallingSwords'],
      },
      {
        hpThreshold: 0.5,
        name: 'Temporal Collapse',
        speedMult: 1.42,
        attacks: ['swordCombo', 'dashSlash', 'shurikenFan', 'hookPull', 'fallingSwords'],
      },
    ],
    cellReward: 40,
    goldReward: 700,
    spriteKey: 'boss_TimeKeeper',
  },
  {
    id: 'KingsHand',
    cdbId: 'KingsHand',
    name: 'The Sovereign Hand',
    subtitle: 'Shield of the Fallen Throne',
    biomeId: 'Throne',
    baseHp: 5900,
    baseDamage: 28,
    width: 40,
    height: 56,
    phases: [
      {
        hpThreshold: 1.0,
        name: 'Royal Sentinel',
        speedMult: 1.0,
        attacks: ['lanceCombo', 'bombFlurry', 'shieldCharge', 'jabTelluric', 'telluricSlam', 'dropBanners'],
      },
      {
        hpThreshold: 0.85,
        name: 'Vanguard Reinforcements',
        speedMult: 1.18,
        attacks: ['lanceCombo', 'bombFlurry', 'shieldCharge', 'jabTelluric', 'dropBanners', 'telluricSlam'],
      },
      {
        hpThreshold: 0.4,
        name: 'Sovereign Cataclysm',
        speedMult: 1.35,
        attacks: ['superSlam', 'lanceCombo', 'bombFlurry', 'shieldCharge', 'jabTelluric', 'dropBanners', 'telluricSlam'],
      },
    ],
    cellReward: 80,
    goldReward: 1200,
    spriteKey: 'boss_KingsHand',
  },
];

export const BOSS_MAP: Readonly<Record<BossId, BossDef>> = BOSSES.reduce(
  (acc, boss) => {
    acc[boss.id] = boss;
    return acc;
  },
  {} as Record<BossId, BossDef>
);
