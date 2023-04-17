import React, { type ReactNode } from "react";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";

type LinkProps = {
  children: string | ReactNode;
  href: string;
  isExternal?: boolean;
};

export const Link: React.FC<LinkProps> = function ({
  children,
  href,
  isExternal = false,
}) {
  return (
    <a
      href={href}
      target={isExternal ? "_blank" : "_self"}
      className="relative inline-flex items-center text-link-light hover:underline dark:text-link-dark"
    >
      <span className="truncate">{children}</span>
      {isExternal && (
        <ArrowTopRightOnSquareIcon
          className="relative bottom-[1px] ml-1 h-5 w-5"
          aria-hidden="true"
        />
      )}
    </a>
  );
};
