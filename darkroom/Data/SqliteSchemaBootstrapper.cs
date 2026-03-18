using System.Data;
using Microsoft.EntityFrameworkCore;

namespace Darkroom.Data;

public static class SqliteSchemaBootstrapper
{
    public static void EnsureLatest(AppDbContext db)
    {
        var connection = db.Database.GetDbConnection();
        var shouldClose = connection.State != ConnectionState.Open;
        if (shouldClose)
        {
            connection.Open();
        }

        try
        {
            EnsureColumn(connection, table: "Rooms", column: "LastEmptyAtUnixSeconds", definition: "INTEGER NULL");
        }
        finally
        {
            if (shouldClose)
            {
                connection.Close();
            }
        }
    }

    private static void EnsureColumn(
        System.Data.Common.DbConnection connection,
        string table,
        string column,
        string definition)
    {
        if (ColumnExists(connection, table, column))
        {
            return;
        }

        using var command = connection.CreateCommand();
        command.CommandText = $"ALTER TABLE {table} ADD COLUMN {column} {definition};";
        command.ExecuteNonQuery();
    }

    private static bool ColumnExists(System.Data.Common.DbConnection connection, string table, string column)
    {
        using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA table_info('{table}');";

        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            var name = reader.GetString(1);
            if (string.Equals(name, column, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }
}

