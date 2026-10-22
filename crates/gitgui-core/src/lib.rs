pub mod git {
    pub mod cache;
    pub mod command;
    #[cfg(test)]
    mod file_view_measurement;
    pub mod graph;
    pub mod hunk_cache;
    pub mod operations;
    pub mod repository;
    pub mod watch;
    pub mod working_tree;
    pub mod worktrees;
}
