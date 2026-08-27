import { Link } from "react-router-dom";
import AppIcon from "../components/common/AppIcon.jsx";
import BrandLogo from "../components/common/BrandLogo.jsx";
import PublicAdminLink from "../components/layout/PublicAdminLink.jsx";
import PublicFooter from "../components/layout/PublicFooter.jsx";

const founders = [
  {
    accent: "lime",
    avatar: "hassan",
    name: "Hassan Sajjad",
    designation: "Co-Founder & CEO",
    specialty: "DevOps Engineer",
    punchline: "The force that carried an ambitious idea through every failure, rebuild, and breakthrough until it became real.",
    description: "Drives DeployGuard from product vision to cloud execution, leading infrastructure, DevOps, automation, and the relentless debugging that keeps the whole system moving.",
    photo: "/team/hassan-sajjad.webp",
    linkedin: "https://www.linkedin.com/in/hassan-sajjad-2751202b9",
    github: "https://github.com/Hassan-Sajjad72",
    portfolio: "https://hassan-sajjad72.github.io/",
  },
  {
    accent: "violet",
    avatar: "faria",
    name: "Faria Fatima",
    designation: "Co-Founder",
    specialty: "Backend & Systems Engineer",
    punchline: "The mind that finds clarity in the mess and a way forward when the obvious answers stop working.",
    description: "Leads DeployGuard’s backend foundation, shaping APIs, system logic, integrations, and reliability while turning complex failures into solutions that keep the platform working as one.",
    linkedin: null,
    github: null,
    portfolio: null,
  },
  {
    accent: "cyan",
    avatar: "tania",
    name: "Tania Khawar",
    designation: "Co-Founder",
    specialty: "Backend & AI Engineer",
    punchline: "The thinker who questions what everyone else accepts—and often uncovers what nobody else thought to look for.",
    description: "Shapes DeployGuard across backend, AI, and monitoring with sharp architectural judgment—challenging assumptions that uncovered hidden defects and repeatedly made the system stronger.",
    photo: "/team/tania-khawar.webp",
    linkedin: "https://www.linkedin.com/in/tania-khawar-8a0965372",
    github: "https://github.com/232378taniakhawar",
    portfolio: null,
  },
];

const socialLabels = { linkedin: "LinkedIn", github: "GitHub", portfolio: "Portfolio" };

function SocialIcon({ type }) {
  if (type === "github") return <AppIcon name="github" size={18} />;
  if (type === "linkedin") return <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18"><path d="M6.5 9.5V18m0-11.8v.1M10.5 18v-8.5m0 3.7c.7-2.4 6-3.2 6 1V18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /><rect height="18" rx="3" stroke="currentColor" strokeWidth="1.8" width="18" x="3" y="3" /></svg>;
  return <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" /><path d="M3.5 12h17M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg>;
}

function FounderSocials({ founder }) {
  return <div aria-label={`${founder.name} social profiles`} className="founder-socials">
    {Object.keys(socialLabels).map((type) => {
      const href = founder[type];
      const label = socialLabels[type];
      return href
        ? <a aria-label={`${founder.name} on ${label}`} href={href} key={type} rel="noreferrer" target="_blank"><SocialIcon type={type} /><span>{label}</span></a>
        : <span aria-disabled="true" aria-label={`${founder.name} ${label} profile is not available yet`} className="is-disabled" key={type} title="Profile link not available"><SocialIcon type={type} /><span>{label}</span></span>;
    })}
  </div>;
}

function TeamAvatar({ accent, name, photo, variant }) {
  if (photo) return <img alt={`${name}, DeployGuard co-founder`} className={`team-avatar team-avatar-photo portrait-${variant}`} src={photo} />;

  const common = <><circle className="team-avatar-backdrop" cx="90" cy="90" r="86" /><path className="team-avatar-shadow" d="M30 176c4-38 26-58 60-58s56 20 60 58" /></>;

  if (variant === "faria") return <svg aria-label={`Illustrated portrait of ${name}`} className={`team-avatar tone-${accent}`} role="img" viewBox="0 0 180 180">
    {common}<path className="team-avatar-jacket avatar-violet" d="M27 180c3-38 27-61 63-61s60 23 63 61" /><path className="team-avatar-shirt" d="m70 121 20 27 20-27" />
    <path className="team-avatar-long-hair" d="M49 65c0-34 17-51 42-51 29 0 45 21 45 52l-6 61-23-11H69l-21 11Z" /><ellipse className="team-avatar-face face-warm" cx="91" cy="73" rx="35" ry="41" />
    <path className="team-avatar-fringe" d="M58 66c2-28 16-43 36-43 18 0 31 12 35 35-13-3-25-11-32-22-9 14-22 24-39 30" /><circle className="team-avatar-eye" cx="77" cy="74" r="2.8" /><circle className="team-avatar-eye" cx="105" cy="74" r="2.8" /><path className="team-avatar-smile" d="M80 94c8 7 17 7 25-1" /><path className="team-avatar-earring" d="M55 82v8m72-8v8" />
  </svg>;

  if (variant === "tania") return <svg aria-label={`Illustrated portrait of ${name}`} className={`team-avatar tone-${accent}`} role="img" viewBox="0 0 180 180">
    {common}<path className="team-avatar-jacket avatar-cyan" d="M25 180c5-40 28-60 65-60s60 20 65 60" /><path className="team-avatar-shirt" d="m66 123 24 25 24-25" />
    <path className="team-avatar-bob-hair" d="M48 68c0-35 17-54 43-54 30 0 46 22 46 55v35c-9 12-22 18-38 19l-9-15-10 15c-15-1-27-7-35-18Z" /><ellipse className="team-avatar-face face-gold" cx="91" cy="72" rx="34" ry="40" />
    <path className="team-avatar-side-fringe" d="M56 65c3-28 18-43 38-43 15 0 28 9 34 27-20-1-35-8-43-19-5 16-14 27-29 35" /><path className="team-avatar-brow" d="M69 70c5-3 10-3 15 0m14 0c5-3 10-3 15 0" /><circle className="team-avatar-eye" cx="77" cy="77" r="2.8" /><circle className="team-avatar-eye" cx="105" cy="77" r="2.8" /><path className="team-avatar-smile" d="M79 95c9 5 18 4 25-3" />
  </svg>;

  return <svg aria-label={`Illustrated portrait of ${name}`} className={`team-avatar tone-${accent}`} role="img" viewBox="0 0 180 180">
    {common}<path className="team-avatar-jacket" d="M25 180c5-39 29-60 65-60s60 21 65 60" /><path className="team-avatar-shirt" d="m65 124 25 25 25-25" /><ellipse className="team-avatar-face" cx="90" cy="72" rx="35" ry="41" />
    <path className="team-avatar-hair" d="M54 66c0-34 16-51 38-51 27 0 43 20 43 49-15-4-25-13-31-27-11 15-27 25-50 29" /><path className="team-avatar-beard" d="M61 85c8 28 48 32 59-1-2 30-13 43-30 43S63 114 61 85Z" /><g className="team-avatar-glasses"><rect height="18" rx="7" width="29" x="56" y="66" /><rect height="18" rx="7" width="29" x="95" y="66" /><path d="M85 73h10" /></g><path className="team-avatar-smile light-smile" d="M80 98c7 4 14 4 21 0" />
  </svg>;
}

export default function About() {
  return <div className="about-page">
    <header className="public-header glass-nav">
      <Link aria-label="DeployGuard home" to="/"><BrandLogo /></Link>
      <nav aria-label="Public navigation"><Link className="landing-about-link" to="/about">About us</Link><PublicAdminLink /></nav>
    </header>

    <main>
      <section className="about-hero">
        <div><p className="eyebrow">The people behind DeployGuard</p><h1>Three founders.<br /><span>One platform.</span></h1><h2>Different minds. Shared vision.</h2></div>
        <div className="about-hero-copy"><p>DeployGuard brings product thinking, backend engineering, cloud infrastructure, DevOps, and AI into one shared build.</p><strong>Different specialties. Shared ownership.</strong></div>
      </section>

      <section aria-labelledby="mission-title" className="about-mission"><p className="eyebrow">Our mission</p><h2 id="mission-title">Our mission: Turn complex cloud deployment into a secure, automated path from repository to running infrastructure.</h2></section>

      <section aria-labelledby="team-title" className="about-team-section" id="team">
        <div className="about-section-heading"><p className="eyebrow">Founding team</p><h2 id="team-title">Meet the builders.</h2><p>Each founder brings a different engineering edge to DeployGuard while sharing ownership of the platform as a whole.</p></div>
        <div className="team-stack">{founders.map((founder) => <article className={`team-member-card tone-${founder.accent}`} key={founder.name}>
          <TeamAvatar accent={founder.accent} name={founder.name} photo={founder.photo} variant={founder.avatar} />
          <div className="team-member-copy"><p className="founder-designation">{founder.designation}</p><h3>{founder.name}</h3><p className="founder-specialty">{founder.specialty}</p><h4 className="founder-punchline">{founder.punchline}</h4><p className="founder-description">{founder.description}</p></div>
          <FounderSocials founder={founder} />
        </article>)}</div>
      </section>

      <section aria-labelledby="acknowledgements-title" className="about-acknowledgements">
        <div><p className="eyebrow">Mentor &amp; acknowledgements</p><h2 id="acknowledgements-title">Guidance behind the work.</h2></div>
        <dl><div><dt>Mentorship</dt><dd>Asim Ali Fayyaz</dd></div><div><dt>Supervision</dt><dd>Yaseen Mushtaq</dd></div><div><dt>Company</dt><dd><a href="https://www.intelligement.com" rel="noreferrer" target="_blank">Intelligement<span aria-hidden="true"> ↗</span></a></dd></div></dl>
      </section>

      <section className="about-collaboration" id="philosophy">
        <div aria-hidden="true" className="collaboration-mark"><span /><span /><span /></div>
        <div><p className="eyebrow">How we build</p><h2>Ideas come in, assumptions get challenged, and stronger products make it out.</h2></div>
      </section>
    </main>

    <PublicFooter />
  </div>;
}
