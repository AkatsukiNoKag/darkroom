namespace Darkroom.Infrastructure;

public sealed class UserContextAccessor(IHttpContextAccessor httpContextAccessor)
{
    public UserContext Current
    {
        get
        {
            var httpContext = httpContextAccessor.HttpContext
                ?? throw new InvalidOperationException("No active HttpContext.");

            if (httpContext.Items.TryGetValue(UserContextMiddleware.ItemKey, out var value)
                && value is UserContext ctx)
            {
                return ctx;
            }

            throw new InvalidOperationException("UserContextMiddleware not configured.");
        }
    }
}

