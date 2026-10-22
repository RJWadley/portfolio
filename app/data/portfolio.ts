export interface WorkCard {
  title: string;
  index: string;
  lead: string;
  recognition: string;
  href: string;
  linkText: string;
  cursor: string;
  style: Record<string, string>;
  image: string;
  width: number;
  height: number;
  video?: string;
}
export interface ArchiveItem {
  name: string;
  note?: string;
}
export interface OpenSourceItem {
  name: string;
  description: string;
  tag: string;
  href: string;
}
export interface TimelineItem {
  duration: string;
  name: string;
  description: string;
}
export interface PlaygroundItem {
  name: string;
  description: string;
  href: string;
  image: string;
  alt: string;
  width: number;
  height: number;
}

export const workCards: readonly WorkCard[] = [
  {
    title: "New Form Capital",
    index: "01 / 03 · 2022",
    lead: "A venture capital site where the type and imagery won’t sit still: oversized words, inset video, and lots of small, playful moments.",
    recognition: "CSS Design Awards · Site of the Day",
    href: "https://www.reformcollective.com/newform",
    linkText: "See the project",
    cursor: "Watch it move",
    style: {
      "--bg": "#eef0ec",
      "--ink": "#121412",
      "--accent": "#1fd25b",
    },
    image: "/images/work/newform-motion.webp",
    width: 1600,
    height: 1420,
    video: "/images/work/newform-loop.webm",
  },
  {
    title: "Runway",
    index: "02 / 03 · 2023",
    lead: "A finance platform site that borrows the language of air travel, so business planning feels a bit more human.",
    recognition: "Awwwards Developer Award · Webby Awards 2024",
    href: "https://runway.reformcollective.com/",
    linkText: "Visit the site",
    cursor: "Take off",
    style: {
      "--bg": "#1b232b",
      "--ink": "#f4f4f1",
      "--accent": "#ffa800",
      "--pos": "0% 50%",
    },
    image: "/images/work/runway.webp",
    width: 1440,
    height: 1000,
  },
  {
    title: "Micro",
    index: "03 / 03 · 2025",
    lead: "A dreamy, expressive site for a workspace that brings email, CRM, and projects together.",
    recognition: "Awwwards Developer Award · CSSDA Site of the Day",
    href: "https://micro.reformcollective.com/",
    linkText: "Visit the site",
    cursor: "Float around",
    style: {
      "--bg": "#121218",
      "--ink": "#f6f2ec",
      "--accent": "#5fe3e0",
      "--pos": "100% 50%",
    },
    image: "/images/work/micro.webp",
    width: 1440,
    height: 1000,
  },
];

export const archiveItems: readonly ArchiveItem[] = [
  {
    name: "RRE Ventures",
    note: "2022",
  },
  {
    name: "Galileo Financial",
    note: "2022",
  },
  {
    name: "Boost Insurance",
    note: "2022",
  },
  {
    name: "Reform Collective",
    note: "2023 site",
  },
  {
    name: "Fluid",
    note: "2023",
  },
  {
    name: "Aerodome",
    note: "2023",
  },
  {
    name: "FlowFi",
    note: "2023",
  },
  {
    name: "Response",
    note: "2023",
  },
  {
    name: "Campfire",
    note: "2024",
  },
  {
    name: "Impilo Health",
    note: "2024",
  },
  {
    name: "Thoughtly",
    note: "2024",
  },
  {
    name: "Willardson Wedding",
    note: "2024",
  },
  {
    name: "Rotate",
    note: "2024",
  },
  {
    name: "Lang.ai",
    note: "2024",
  },
  {
    name: "Hume AI",
    note: "2024",
  },
  {
    name: "Nervana Health",
    note: "2025",
  },
  {
    name: "Reform Collective",
    note: "2025 site",
  },
  {
    name: "Titan Intake",
    note: "2025",
  },
  {
    name: "GEN 1",
  },
  {
    name: "Enzo Health",
  },
  {
    name: "Bigeye",
  },
  {
    name: "ElectronX",
  },
  {
    name: "Metagarage",
  },
  {
    name: "Milkinside",
  },
  {
    name: "Recurrency",
  },
  {
    name: "Sequence",
  },
  {
    name: "Temple St Clair",
  },
  {
    name: "Paccurate",
  },
  {
    name: "Virio",
  },
  {
    name: "VITURE Cyberpunk",
  },
  {
    name: "VITURE Beast",
  },
  {
    name: "VITURE Luma",
  },
];

export const openSource: readonly OpenSourceItem[] = [
  {
    name: "Restyle",
    description:
      "CSS precedence, TypeScript types, ESM support, and browser testing for a React styling library.",
    tag: "5 merged PRs",
    href: "https://github.com/souporserious/restyle/pulls?q=is%3Apr+author%3ARJWadley",
  },
  {
    name: "stylelint-no-unsupported-browser-features",
    description:
      "A Stylelint plugin that flags CSS your target browsers don’t support.",
    tag: "Maintainer",
    href: "https://github.com/RJWadley/stylelint-no-unsupported-browser-features",
  },
  {
    name: "openpilot & opendbc",
    description:
      "Open-source driver assistance and vehicle communication software.",
    tag: "Contributor",
    href: "https://github.com/commaai/opendbc/pulls?q=is%3Apr+author%3ARJWadley",
  },
  {
    name: "And more",
    description: "doiuse, vanilla-extract, styled-components, and others.",
    tag: "GitHub",
    href: "https://github.com/RJWadley",
  },
];

export const timeline: readonly TimelineItem[] = [
  {
    duration: "4.5 yrs",
    name: "Reform Collective",
    description: "Creative Experience Developer",
  },
  {
    duration: "1.5 yrs",
    name: "Brigham Young University",
    description:
      "Web Developer, College of Family, Home, and Social Sciences. Sites for professors, departments, and the university.",
  },
  {
    duration: "Study",
    name: "Brigham Young University",
    description: "Provo, Utah",
  },
];

export const playground: readonly PlaygroundItem[] = [
  {
    href: "https://www.mrtrapidroute.com/",
    image: "/images/play/rapidroute.webp",
    alt: "RapidRoute's route planner showing stations beside a map of the Minecraft Rapid Transit network",
    width: 1200,
    height: 676,
    name: "RapidRoute",
    description:
      "A route planner for the biggest transit network in Minecraft.",
  },
  {
    href: "https://rjwadley.github.io/",
    image: "/images/play/canvas-toys.webp",
    alt: "A grid of colorful canvas experiments named Cloud, Confetti, Gravity, Bubbles, Tails, and Grow",
    width: 1200,
    height: 676,
    name: "Canvas toys",
    description:
      "Little physics and particle experiments, made just because.",
  },
];
