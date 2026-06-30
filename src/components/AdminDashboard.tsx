import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Users, Gamepad2, Coins, Trophy, Loader2, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useState } from 'react';
import { toast } from 'sonner';

export const AdminDashboard = () => {
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);

  const copyToClipboard = (address: string) => {
    navigator.clipboard.writeText(address);
    setCopiedAddress(address);
    toast.success('Wallet address copied!');
    setTimeout(() => setCopiedAddress(null), 2000);
  };

  const { data: stats, isLoading } = useQuery({
    queryKey: ['admin-stats'],
    queryFn: async () => {
      const [playersRes, sessionsRes] = await Promise.all([
        supabase.from('players').select('id, wallet_address, username, created_at'),
        supabase.from('game_sessions').select('id, score, fee_paid, started_at, game_type, player_id'),
      ]);

      const players = playersRes.data || [];
      const sessions = sessionsRes.data || [];

      const totalFees = sessions.reduce(
        (sum, s) => sum + parseFloat(s.fee_paid?.toString() || '0'),
        0
      );
      const highestScore = Math.max(...sessions.map(s => s.score || 0), 0);

      // Build a map of player_id -> player info
      const playerMap = new Map(players.map(p => [p.id, p]));

      // Separate sessions by game type and get unique players per game
      const gameTypes = ['2048', 'tetris', 'typing'] as const;
      const playersByGame: Record<string, any[]> = {};

      for (const gt of gameTypes) {
        const gameSessions = sessions.filter(s => s.game_type === gt);
        const uniquePlayerIds = [...new Set(gameSessions.map(s => s.player_id))];
        playersByGame[gt] = uniquePlayerIds
          .map(pid => {
            const player = playerMap.get(pid);
            if (!player) return null;
            const playerSessions = gameSessions.filter(s => s.player_id === pid);
            const bestScore = Math.max(...playerSessions.map(s => s.score || 0), 0);
            const totalGames = playerSessions.length;
            return { ...player, bestScore, totalGames };
          })
          .filter(Boolean)
          .sort((a: any, b: any) => b.bestScore - a.bestScore);
      }

      return {
        totalPlayers: players.length,
        totalGames: sessions.length,
        totalFees: totalFees.toFixed(6),
        highestScore,
        playersByGame,
      };
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const PlayerList = ({ players }: { players: any[] }) => (
    players.length === 0 ? (
      <p className="text-muted-foreground text-center py-4">No players yet</p>
    ) : (
      <div className="space-y-2">
        {players.map((player: any) => (
          <div
            key={player.id}
            className="flex items-center justify-between p-3 rounded-lg bg-secondary/50"
          >
            <div className="flex-1 min-w-0 mr-2">
              {player.username && (
                <p className="text-sm font-semibold truncate">{player.username}</p>
              )}
              <p className="font-mono text-xs text-muted-foreground truncate">{player.wallet_address}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs font-medium bg-primary/10 text-primary px-2 py-0.5 rounded">
                {player.bestScore?.toLocaleString()} pts
              </span>
              <span className="text-xs text-muted-foreground">
                {player.totalGames}g
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyToClipboard(player.wallet_address)}
                className="h-7 w-7 p-0 hover:bg-primary/20"
              >
                {copiedAddress === player.wallet_address ? (
                  <Check className="h-3 w-3 text-green-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
            </div>
          </div>
        ))}
      </div>
    )
  );

  return (
    <div className="w-full max-w-4xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold gradient-title">Admin Dashboard</h2>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 px-3 pt-3">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Users className="h-3.5 w-3.5" /> Players
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3">
            <p className="text-xl font-bold">{stats?.totalPlayers || 0}</p>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2 px-3 pt-3">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Gamepad2 className="h-3.5 w-3.5" /> Games
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3">
            <p className="text-xl font-bold">{stats?.totalGames || 0}</p>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2 px-3 pt-3">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Coins className="h-3.5 w-3.5" /> Fees
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3">
            <p className="text-xl font-bold text-accent">{stats?.totalFees} ETH</p>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2 px-3 pt-3">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Trophy className="h-3.5 w-3.5" /> High Score
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3">
            <p className="text-xl font-bold">{stats?.highestScore?.toLocaleString() || 0}</p>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Players by Game</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="2048">
            <TabsList className="w-full">
              <TabsTrigger value="2048" className="flex-1">
                🔢 2048 ({stats?.playersByGame?.['2048']?.length || 0})
              </TabsTrigger>
              <TabsTrigger value="tetris" className="flex-1">
                🧱 Tetris ({stats?.playersByGame?.['tetris']?.length || 0})
              </TabsTrigger>
              <TabsTrigger value="typing" className="flex-1">
                ⌨️ Typing ({stats?.playersByGame?.['typing']?.length || 0})
              </TabsTrigger>
            </TabsList>
            <TabsContent value="2048" className="mt-3">
              <PlayerList players={stats?.playersByGame?.['2048'] || []} />
            </TabsContent>
            <TabsContent value="tetris" className="mt-3">
              <PlayerList players={stats?.playersByGame?.['tetris'] || []} />
            </TabsContent>
            <TabsContent value="typing" className="mt-3">
              <PlayerList players={stats?.playersByGame?.['typing'] || []} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
};
