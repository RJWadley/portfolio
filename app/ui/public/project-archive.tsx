import { clientEntry, ref, type Handle, type RemixNode } from "remix/component";
import { Marquee } from "./marquee.tsx";
import { enhanceArchive } from "./marquee-behavior.js";

type ArchiveProps = { children: RemixNode; count: number; names: string[] };

export const ProjectArchive = clientEntry(
  import.meta.url,
  function ProjectArchive(handle: Handle<ArchiveProps>) {
    return () => (
      <details
        class="archive"
        mix={ref((node: HTMLDetailsElement, signal) => enhanceArchive(node, signal))}
      >
        <summary>
          <Marquee names={handle.props.names} />
          <span class="archive-toggle">
            <span>More Reform work</span>
            <span class="archive-count mono">{handle.props.count} projects</span>
            <i aria-hidden="true" />
          </span>
        </summary>
        <div class="archive-content">{handle.props.children}</div>
      </details>
    );
  },
);
