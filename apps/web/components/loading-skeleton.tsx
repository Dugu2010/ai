"use client";

import { CSSProperties } from "react";

interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ className, style }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse bg-gray-700 rounded ${className || ""}`}
      style={style}
    />
  );
}

export function ProjectSkeleton() {
  return (
    <div className="p-4 bg-gray-800 rounded border border-gray-700">
      <div className="flex justify-between items-start">
        <div className="flex-1">
          <Skeleton className="h-6 w-32 mb-2" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20 mt-2" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-8 w-16" />
        </div>
      </div>
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="min-h-screen bg-gray-900 p-4">
      <div className="max-w-4xl mx-auto">
        <Skeleton className="h-8 w-32 mb-8" />
        <div className="space-y-4">
          <ProjectSkeleton />
          <ProjectSkeleton />
          <ProjectSkeleton />
        </div>
      </div>
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="p-4 bg-gray-800 rounded border border-gray-700">
      <Skeleton className="h-5 w-40 mb-2" />
      <Skeleton className="h-4 w-full mb-2" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
