use anchor_lang::prelude::*;

declare_id!("CubeGameXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"); // Replace after deployment

#[program]
pub mod cube_game {
    use super::*;

    /// Initialize the game state (call once)
    pub fn initialize(ctx: Context<Initialize>, price_per_cube: u64) -> Result<()> {
        let game = &mut ctx.accounts.game_state;
        game.authority = ctx.accounts.authority.key();
        game.price_per_cube = price_per_cube;
        game.total_cubes_removed = 0;
        game.bump = ctx.bumps.game_state;
        Ok(())
    }

    /// Remove a cube by paying the required fee
    pub fn remove_cube(ctx: Context<RemoveCube>, cube_id: String) -> Result<()> {
        let game = &mut ctx.accounts.game_state;
        let cube_record = &mut ctx.accounts.cube_record;
        let player = &ctx.accounts.player;

        // Check cube hasn't been removed already
        require!(!cube_record.is_removed, CubeGameError::CubeAlreadyRemoved);

        // Transfer payment to treasury
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &player.key(),
            &ctx.accounts.treasury.key(),
            game.price_per_cube,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                player.to_account_info(),
                ctx.accounts.treasury.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // Mark cube as removed
        cube_record.is_removed = true;
        cube_record.removed_by = player.key();
        cube_record.removed_at = Clock::get()?.unix_timestamp;
        cube_record.cube_id = cube_id.clone();

        // Update game stats
        game.total_cubes_removed += 1;

        // Update player stats
        let player_stats = &mut ctx.accounts.player_stats;
        player_stats.cubes_removed += 1;
        player_stats.player = player.key();

        emit!(CubeRemovedEvent {
            cube_id,
            player: player.key(),
            total_removed: game.total_cubes_removed,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Update the price (owner only)
    pub fn set_price(ctx: Context<SetPrice>, new_price: u64) -> Result<()> {
        let game = &mut ctx.accounts.game_state;
        game.price_per_cube = new_price;
        Ok(())
    }

    /// Withdraw funds (owner only)
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let treasury = &ctx.accounts.treasury;
        let authority = &ctx.accounts.authority;

        **treasury.to_account_info().try_borrow_mut_lamports()? -= amount;
        **authority.to_account_info().try_borrow_mut_lamports()? += amount;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + GameState::INIT_SPACE,
        seeds = [b"game_state"],
        bump
    )]
    pub game_state: Account<'info, GameState>,

    /// CHECK: Treasury PDA to hold funds
    #[account(
        seeds = [b"treasury"],
        bump
    )]
    pub treasury: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(cube_id: String)]
pub struct RemoveCube<'info> {
    #[account(
        mut,
        seeds = [b"game_state"],
        bump = game_state.bump
    )]
    pub game_state: Account<'info, GameState>,

    #[account(
        init_if_needed,
        payer = player,
        space = 8 + CubeRecord::INIT_SPACE,
        seeds = [b"cube", cube_id.as_bytes()],
        bump
    )]
    pub cube_record: Account<'info, CubeRecord>,

    #[account(
        init_if_needed,
        payer = player,
        space = 8 + PlayerStats::INIT_SPACE,
        seeds = [b"player", player.key().as_ref()],
        bump
    )]
    pub player_stats: Account<'info, PlayerStats>,

    /// CHECK: Treasury PDA
    #[account(
        mut,
        seeds = [b"treasury"],
        bump
    )]
    pub treasury: AccountInfo<'info>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    #[account(
        mut,
        seeds = [b"game_state"],
        bump = game_state.bump,
        has_one = authority
    )]
    pub game_state: Account<'info, GameState>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        seeds = [b"game_state"],
        bump = game_state.bump,
        has_one = authority
    )]
    pub game_state: Account<'info, GameState>,

    /// CHECK: Treasury PDA
    #[account(
        mut,
        seeds = [b"treasury"],
        bump
    )]
    pub treasury: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct GameState {
    pub authority: Pubkey,
    pub price_per_cube: u64,
    pub total_cubes_removed: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CubeRecord {
    pub is_removed: bool,
    pub removed_by: Pubkey,
    pub removed_at: i64,
    #[max_len(32)]
    pub cube_id: String,
}

#[account]
#[derive(InitSpace)]
pub struct PlayerStats {
    pub player: Pubkey,
    pub cubes_removed: u64,
}

#[event]
pub struct CubeRemovedEvent {
    pub cube_id: String,
    pub player: Pubkey,
    pub total_removed: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum CubeGameError {
    #[msg("This cube has already been removed")]
    CubeAlreadyRemoved,
}
