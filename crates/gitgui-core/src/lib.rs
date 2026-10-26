pub mod git {
    pub mod cache;
    pub mod command;
    #[cfg(test)]
    mod file_view_measurement;
    #[cfg(test)]
    mod discard_measurement;
    pub mod graph;
    pub mod hunk_cache;
    pub mod operations;
    pub mod stash_actions;
    pub mod repository;
    pub mod stash_selected;
    pub mod stash;
    pub mod stash_inspection;
    pub mod stash_inspection_cache;
    pub(crate) mod stash_read;
    pub mod watch;
    pub mod working_tree;
    pub mod worktrees;
}
